import React from 'react';
import { ResponsiveContainer, BarChart, Bar, LineChart, Line, XAxis, YAxis, Tooltip, CartesianGrid, Legend } from 'recharts';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { QueryResult } from '@/types';

// SVG presentation attributes can't resolve CSS variables, so read the theme tokens at render time.
function seriesColors(): string[] {
  const cs = getComputedStyle(document.documentElement);
  return ['--chart-1', '--chart-2', '--chart-3'].map((v, i) => cs.getPropertyValue(v).trim() || ['#4F46E5', '#0D9488', '#D97706'][i]);
}
const DASH = [undefined, '6 3', '2 3'];

/** Analytics result: optional chart (one axis, fixed series order, hover tooltip) plus the table view. */
export function ResultChart({ result }: { result: QueryResult }) {
  const SERIES = seriesColors();
  const ch = result.chart;
  const data = ch
    ? result.rows.map((r) => {
        const o: Record<string, any> = { x: r[ch.x] };
        ch.y.forEach((yi) => (o[result.columns[yi]] = r[yi]));
        return o;
      })
    : [];
  const ys = ch ? ch.y.map((i) => result.columns[i]) : [];
  const axis = { stroke: 'hsl(var(--muted-foreground))', fontSize: 11, tickLine: false, axisLine: false };
  const tip = { contentStyle: { background: 'hsl(var(--card))', border: '1px solid hsl(var(--border))', borderRadius: 8, fontSize: 12 } };
  return (
    <div className="space-y-4">
      {ch && data.length > 0 && (
        <div className="h-56">
          <ResponsiveContainer width="100%" height="100%">
            {ch.type === 'bar' ? (
              <BarChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="x" {...axis} />
                <YAxis {...axis} allowDecimals />
                <Tooltip {...tip} cursor={{ fill: 'hsl(var(--muted))' }} />
                {ys.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
                {ys.map((y, i) => (
                  <Bar key={y} dataKey={y} fill={SERIES[i]} radius={[4, 4, 0, 0]} maxBarSize={36} />
                ))}
              </BarChart>
            ) : (
              <LineChart data={data} margin={{ top: 8, right: 8, left: -12, bottom: 0 }}>
                <CartesianGrid vertical={false} stroke="hsl(var(--border))" />
                <XAxis dataKey="x" {...axis} />
                <YAxis {...axis} allowDecimals={false} />
                <Tooltip {...tip} />
                {ys.length > 1 && <Legend wrapperStyle={{ fontSize: 11 }} />}
                {ys.map((y, i) => (
                  <Line key={y} dataKey={y} stroke={SERIES[i]} strokeWidth={2} strokeDasharray={DASH[i]} dot={{ r: 4 }} activeDot={{ r: 5 }} />
                ))}
              </LineChart>
            )}
          </ResponsiveContainer>
        </div>
      )}
      <div className="border rounded-lg overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              {result.columns.map((c) => (
                <TableHead key={c} className="text-xs">
                  {c}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {result.rows.length === 0 ? (
              <TableRow>
                <TableCell colSpan={result.columns.length} className="text-center text-xs text-muted-foreground py-6">
                  No rows
                </TableCell>
              </TableRow>
            ) : (
              result.rows.map((r, i) => (
                <TableRow key={i}>
                  {r.map((v, j) => (
                    <TableCell key={j} className={`text-xs ${typeof v === 'number' ? 'font-mono' : ''}`}>
                      {v === null || v === undefined ? '—' : String(v)}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
