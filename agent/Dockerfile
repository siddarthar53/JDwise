FROM python:3.12-slim
WORKDIR /app
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app
COPY data ./data
COPY evals ./evals
RUN useradd -m agent && mkdir -p /app/.state && chown -R agent /app
USER agent
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=3s CMD python -c "import urllib.request;urllib.request.urlopen('http://localhost:8001/health')"
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8001"]
