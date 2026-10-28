"""Layer 8 — permission-aware Q&A and summarisation over JDs and conversations.

The Express API computes which JDs and conversations the asking user may see and
passes those ids; retrieval is filtered to them *before* ranking, so content the
user cannot access can never reach the prompt or the answer.
"""
from __future__ import annotations

import json
import re

from .. import knowledge, llm, runctx, services
from ..guard import as_data
from ..rag.embed import tokenize
from ..rag.retriever import Filters
from ..schemas import QAAnswer

QA_STOP = set("""what which who whom whose when where why how did does do is are was were the a an of to on in for about
with from and or me my our we us you your they their them it its this that these those role roles jd jds job jobs description
descriptions hr say said tell show give list any some all there here please can could would should will team person
summarize summarise summary thread threads discussion feedback object objected objection objections comment comments
last time latest recent""".split())

REFUSAL = "I couldn't find anything about that in the job descriptions or conversations you have access to."
MIN_RELEVANCE = 0.12


def _cite(h: dict) -> dict:
    c = h["chunk"]
    return {"id": c["id"], "doc_id": c["doc_id"], "doc_type": c["doc_type"], "title": c["title"], "section": c["section"],
            "text": c["text"][:300]}


def answer(question: str, allowed_jd_ids: list[str], allowed_conversations: list[str], jd_index: list[dict] | None = None) -> QAAnswer:
    ctx = runctx.current()
    filters = Filters(doc_types=["jd", "message"], allowed_doc_ids=set(map(str, allowed_jd_ids)),
                      allowed_conversations=set(map(str, allowed_conversations)))
    q = question.strip()

    # structured question: "which (open) roles need/require <skill>?"
    m = re.search(r"which\s+(open\s+|approved\s+|pending\s+)?(roles|jds|jobs|positions|job descriptions)\s+(need|require|use|mention|ask for|include)\s+(.+?)\??$", q, re.I)
    if m and jd_index is not None:
        skills = knowledge.find_skills(m.group(4)) or [m.group(4).strip()]
        want = (m.group(1) or "").strip().lower()
        rows = []
        for jd in jd_index:
            if str(jd["id"]) not in filters.allowed_doc_ids:
                continue
            if want == "open" and jd.get("status") in ("rejected", "draft"):
                continue
            if want == "approved" and jd.get("status") != "approved":
                continue
            if want == "pending" and not str(jd.get("status", "")).startswith("pending"):
                continue
            hay = " ".join([jd.get("title", ""), " ".join(jd.get("skills") or []), " ".join(jd.get("qualifications") or [])]).lower()
            if all(s.lower() in hay for s in skills):
                rows.append(jd)
        if not rows:
            ans = f"None of the {want + ' ' if want else ''}roles you can see mention {', '.join(skills)}."
        else:
            ans = f"{len(rows)} {want + ' ' if want else ''}role(s) mention {', '.join(skills)}:\n" + "\n".join(
                f"- {r['title']} ({r.get('department') or '—'}, {r.get('status')})" for r in rows)
        ctx.event("qa", "Answered structured skill query", matches=len(rows))
        return QAAnswer(answer=ans, citations=[{"doc_id": r["id"], "doc_type": "jd", "title": r["title"], "section": "skills", "text": ", ".join(r.get("skills") or [])} for r in rows])

    hits = services.get_retriever().search(q, k=8, filters=filters, min_score=MIN_RELEVANCE)
    # require that a hit shares at least one *salient* term with the question,
    # so generic words ("what did HR say about the role") can't pull in unrelated content
    salient = {t[:5] for t in tokenize(q) if t not in QA_STOP and len(t) > 2}
    if salient:
        need = max(1, (len(salient) + 1) // 2)
        hits = [h for h in hits if len(salient & {t[:5] for t in tokenize(h["chunk"]["title"] + " " + h["chunk"]["text"])}) >= need]
    if not hits:
        ctx.event("qa", "No permitted content above relevance threshold; refusing")
        return QAAnswer(answer=REFUSAL, refused=True)

    try:
        ctx_txt = "\n".join(f"[{h['chunk']['id']}] {h['chunk']['title']} ({h['chunk']['section']}): {h['chunk']['text']}" for h in hits)
        res = llm.structured("qa", QAAnswer,
                             "Answer the user's question using only the provided context. Cite chunk ids in citations as {\"id\": ...}. "
                             "If the context does not contain the answer, set refused=true and say so briefly.",
                             f"Question: {q}\n\n" + as_data("context", ctx_txt, max_chars=10000), tier="small", max_tokens=900)
        by_id = {h["chunk"]["id"]: h for h in hits}
        cites = [_cite(by_id[c.get("id")]) for c in res.citations if c.get("id") in by_id]
        ctx.event("qa", "Answered with LLM over permitted context", citations=len(cites))
        return QAAnswer(answer=res.answer, citations=cites, refused=res.refused)
    except llm.LLMUnavailable:
        pass

    # extractive fallback: group by document and quote the most relevant snippets
    lines, seen = [], set()
    summarise = bool(re.search(r"summari[sz]e|summary|what did|objections?|feedback|thread", q, re.I))
    for h in hits[:6]:
        c = h["chunk"]
        key = (c["doc_id"], c["text"][:60])
        if key in seen:
            continue
        seen.add(key)
        label = "💬" if c["doc_type"] == "message" else "📄"
        lines.append(f"- {label} **{c['title']}** ({c['section']}): {c['text'][:220]}")
    head = "Here's what the relevant discussion says:" if summarise else "Here's what I found in the content you can access:"
    ctx.event("qa", "Answered extractively (no LLM)", citations=len(lines))
    return QAAnswer(answer=head + "\n" + "\n".join(lines), citations=[_cite(h) for h in hits[:6]])
