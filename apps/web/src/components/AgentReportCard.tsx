import { useMemo, useState } from "react";
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  MessageSquare,
} from "lucide-react";
import type { AgentReport, AgentReportMessage } from "@rakazo/contracts";
import "../pages/workspace-motion.css";

type Table = Extract<AgentReport["sections"][number], { kind: "table" }>;
export function reportRequest(block: AgentReportMessage, request: string) {
  return `Regarding "${block.report.title}" (report SHA-256 ${block.evidence.reportSha256}):\n${request}\n\nReview this request first. This card selection is not policy approval or additional solve allowance.`;
}
export function orderedReportRows(table: Table, query: string, key?: string, descending = false) {
  const columns = table.columns.map((c) => c.key);
  const needle = query.toLocaleLowerCase();
  const rows = table.rows
    .map((row, index) => ({ row, index }))
    .filter(({ row }) =>
      columns.some((c) =>
        String(row[c] ?? "")
          .toLocaleLowerCase()
          .includes(needle),
      ),
    );
  if (key && columns.includes(key))
    rows.sort((a, b) => {
      const x = a.row[key];
      const y = b.row[key];
      if (x === null || y === null) return x === y ? a.index - b.index : x === null ? 1 : -1;
      const cmp =
        typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y));
      return (descending ? -cmp : cmp) || a.index - b.index;
    });
  return rows;
}
function ReportTable({
  table,
  onRequest,
}: {
  table: Table;
  onRequest?: (request: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<{ key: string; desc: boolean }>();
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<number | null>(null);
  const rows = useMemo(
    () => orderedReportRows(table, query, sort?.key, sort?.desc),
    [table, query, sort],
  );
  const pages = Math.max(1, Math.ceil(rows.length / 25));
  const current = Math.min(page, pages - 1);
  const display = (value: unknown) => (value === null ? "Unavailable" : String(value));
  return (
    <section
      className="w-full min-w-0 max-w-full border-t border-border pt-3"
      aria-label={table.title}
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <h4 className="min-w-0 break-words text-sm font-medium [overflow-wrap:anywhere]">
          {table.title}
        </h4>
        <input
          type="search"
          aria-label={`Search ${table.title}`}
          placeholder="Search"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setPage(0);
            setExpanded(null);
          }}
          className="max-w-full rounded border border-border bg-background px-2 py-1 text-sm"
        />
      </div>
      <div
        tabIndex={0}
        role="region"
        aria-label={`${table.title} table`}
        className="w-full min-w-0 max-w-full max-h-[460px] overflow-auto overscroll-x-contain rounded focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring"
      >
        <table
          className="w-full text-left text-sm"
          style={{ minWidth: table.columns.length * 112 }}
        >
          <thead className="sticky top-0 bg-muted">
            <tr>
              {table.columns.map((col) => (
                <th
                  key={col.key}
                  scope="col"
                  aria-sort={
                    sort?.key === col.key ? (sort.desc ? "descending" : "ascending") : "none"
                  }
                  className="min-w-28 px-2 py-2 [overflow-wrap:normal]"
                >
                  <button
                    type="button"
                    title={`Sort by ${col.label}`}
                    className="inline-flex items-center gap-1 text-left"
                    onClick={() => {
                      setSort({ key: col.key, desc: sort?.key === col.key ? !sort.desc : false });
                      setPage(0);
                      setExpanded(null);
                    }}
                  >
                    {col.label}
                    {sort?.key === col.key ? (
                      sort.desc ? (
                        <ArrowDown size={13} />
                      ) : (
                        <ArrowUp size={13} />
                      )
                    ) : null}
                  </button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.slice(current * 25, current * 25 + 25).map(({ row, index }) => (
              <tr key={index} className="border-t border-border">
                {table.columns.map((col, c) => (
                  <td
                    key={col.key}
                    className={`max-w-64 break-words px-2 py-2 align-top ${col.type === "number" ? "text-right tabular-nums" : "min-w-40"}`}
                  >
                    {c === 0 && table.rowQuestion && onRequest ? (
                      <button
                        type="button"
                        aria-expanded={expanded === index}
                        className="inline-flex items-center gap-1 text-left"
                        onClick={() => setExpanded(expanded === index ? null : index)}
                      >
                        {expanded === index ? (
                          <ChevronDown size={14} className="shrink-0" />
                        ) : (
                          <ChevronRight size={14} className="shrink-0" />
                        )}
                        {display(row[col.key])}
                      </button>
                    ) : (
                      display(row[col.key])
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {expanded !== null && table.rows[expanded] && onRequest && (
        <section aria-label="Selected row" className="mt-3 border-t border-border py-3">
          <dl className="grid grid-cols-2 gap-3">
            {table.columns.map((field) => (
              <div key={field.key} className="min-w-0">
                <dt className="break-words text-xs text-muted-foreground">{field.label}</dt>
                <dd className="break-words text-sm">{display(table.rows[expanded]![field.key])}</dd>
              </div>
            ))}
          </dl>
          <button
            type="button"
            className="mt-3 inline-flex items-center gap-2 text-sm underline"
            onClick={() =>
              onRequest(
                `${table.rowQuestion}\nSelected row: ${JSON.stringify(table.rows[expanded])}`,
              )
            }
          >
            <MessageSquare size={14} />
            Ask about this row
          </button>
        </section>
      )}
      {!rows.length && (
        <p role="status" className="py-3 text-sm text-muted-foreground">
          No matching rows.
        </p>
      )}
      <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground">
        <span>{rows.length} rows</span>
        <span className="inline-flex items-center gap-2">
          <button
            title="Previous page"
            aria-label="Previous page"
            disabled={current === 0}
            onClick={() => {
              setPage(current - 1);
              setExpanded(null);
            }}
            className="p-1 disabled:opacity-30"
          >
            <ChevronLeft size={16} />
          </button>
          {current + 1} / {pages}
          <button
            title="Next page"
            aria-label="Next page"
            disabled={current + 1 >= pages}
            onClick={() => {
              setPage(current + 1);
              setExpanded(null);
            }}
            className="p-1 disabled:opacity-30"
          >
            <ChevronRight size={16} />
          </button>
        </span>
      </div>
    </section>
  );
}
export function AgentReportCard({
  block,
  onCompose,
}: {
  block: AgentReportMessage;
  onCompose?: (request: string) => void;
}) {
  const [notice, setNotice] = useState("");
  const request = (text: string) => {
    onCompose?.(reportRequest(block, text));
    setNotice("Request added to your message.");
  };
  return (
    <article
      aria-label={block.report.title}
      data-agent-report
      className="w-full min-w-0 max-w-full space-y-4 rounded-lg border border-border bg-background p-3 [contain:inline-size] [overflow-wrap:anywhere] sm:p-4"
    >
      <header>
        <span className="text-xs text-muted-foreground">Agent analysis</span>
        <h3 className="mt-1 break-words text-base font-semibold">{block.report.title}</h3>
        {block.report.summary && (
          <p className="mt-2 whitespace-pre-wrap break-words text-sm">{block.report.summary}</p>
        )}
      </header>
      {block.report.sections.map((section, index) =>
        section.kind === "metrics" ? (
          <dl
            key={index}
            className="grid gap-3"
            style={{ gridTemplateColumns: "repeat(auto-fit,minmax(min(100%,9rem),1fr))" }}
          >
            {section.items.map((metric, i) => (
              <div key={i} className="min-w-0">
                <dt className="break-words text-xs text-muted-foreground">{metric.label}</dt>
                <dd className="mt-1 break-words text-lg font-medium tabular-nums">
                  {metric.value === null ? "Unavailable" : metric.value}
                  {metric.unit ? (
                    <span className="ml-1 text-xs font-normal">{metric.unit}</span>
                  ) : null}
                </dd>
              </div>
            ))}
          </dl>
        ) : section.kind === "table" ? (
          <ReportTable key={index} table={section} onRequest={onCompose ? request : undefined} />
        ) : (
          <section key={index} className="border-t border-border pt-3">
            <h4 className="text-sm font-medium">{section.title}</h4>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm">{section.text}</p>
          </section>
        ),
      )}
      {onCompose && block.report.actions?.length ? (
        <div className="flex flex-wrap gap-2 border-t border-border pt-3">
          {block.report.actions.map((action, index) => (
            <button
              key={index}
              type="button"
              onClick={() => request(action.request)}
              className="inline-flex max-w-full items-center gap-2 break-words rounded border border-border px-3 py-2 text-left text-sm"
            >
              <MessageSquare size={14} />
              {action.label}
            </button>
          ))}
        </div>
      ) : null}
      {notice && (
        <p role="status" className="text-xs text-muted-foreground">
          {notice}
        </p>
      )}
      <details className="text-xs text-muted-foreground">
        <summary className="cursor-pointer">Analysis sources</summary>
        <p className="mt-2">
          File hashes identify the captured sources. They do not certify calculations, a roster or
          policy approval.
        </p>
        <p className="mt-2 break-all">
          {block.evidence.reportPath} · {block.evidence.reportSha256}
        </p>
        <ul className="mt-2 space-y-2">
          {block.evidence.sources.map((source) => (
            <li key={source.path} className="break-all">
              {source.path}
              <br />
              {source.sha256}
            </li>
          ))}
        </ul>
      </details>
    </article>
  );
}
