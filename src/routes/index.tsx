import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useMemo, useState } from "react";
import { checkFilters, listFilters, scrapeDomains, type FilterResult, type RdapInfo } from "@/lib/scraper.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MystixScraperChecker — Find unblocked domains" },
      { name: "description", content: "Scrape live domains via RDAP and check them against up to 3 web filters with LLLogan." },
      { property: "og:title", content: "MystixScraperChecker" },
      { property: "og:description", content: "Scrape domains via RDAP and check if they're unblocked by school & DNS filters." },
    ],
  }),
  component: Index,
});

type Filter = { id: string; name: string; kind: string };
const MAX = 3;

function Index() {
  const [filters, setFilters] = useState<Filter[]>([]);
  const [picked, setPicked] = useState<string[]>(["goguardianv3", "securly", "lightspeed"]);
  const [mode, setMode] = useState<"keyword" | "url">("keyword");
  const [query, setQuery] = useState("");
  const [domains, setDomains] = useState<RdapInfo[]>([]);
  const [results, setResults] = useState<FilterResult[]>([]);
  const [busy, setBusy] = useState<"" | "scrape" | "check">("");
  const [err, setErr] = useState("");
  const [onlyClean, setOnlyClean] = useState(false);

  useEffect(() => {
    listFilters().then((r) => setFilters(r.filters)).catch(() => {});
  }, []);

  const toggle = (id: string) =>
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX ? p : [...p, id]));

  async function run() {
    setErr(""); setResults([]); setDomains([]);
    try {
      setBusy("scrape");
      const { domains } = await scrapeDomains({ data: { mode, value: query } });
      setDomains(domains);
      if (!domains.length) { setErr("No registered domains found."); return; }
      setBusy("check");
      const { results } = await checkFilters({ data: { links: domains.map((d) => d.domain), filters: picked } });
      setResults(results);
    } catch (e: any) {
      setErr(e?.message ?? "Something went wrong");
    } finally { setBusy(""); }
  }

  const rows = useMemo(() => {
    const rows = domains.map((d) => {
      const r = results.filter((x) => x.site === d.domain);
      const clean = r.length > 0 && r.every((x) => x.status === "unblocked");
      return { ...d, r, clean };
    });
    rows.sort((a, b) => Number(b.clean) - Number(a.clean));
    return onlyClean ? rows.filter((r) => r.clean) : rows;
  }, [domains, results, onlyClean]);

  const cleanCount = rows.filter((r) => r.clean).length;
  const name = (id: string) => filters.find((f) => f.id === id)?.name ?? id;

  return (
    <main className="mx-auto max-w-4xl px-4 py-10">
      <header className="mb-8">
        <p className="font-mono text-xs uppercase tracking-[0.3em] text-muted-foreground">powered by LLLogan + RDAP</p>
        <h1 className="mt-2 text-4xl font-bold sm:text-6xl"><span className="text-gradient">MystixScraperChecker</span></h1>
        <p className="mt-3 text-muted-foreground">Scrape live domains, then see which slip past your filters.</p>
      </header>

      <section className="rounded-2xl border bg-card p-5 shadow-glow">
        <div className="mb-4 inline-flex rounded-lg bg-muted p-1 font-mono text-sm">
          {(["keyword", "url"] as const).map((m) => (
            <button key={m} onClick={() => setMode(m)}
              className={`rounded-md px-3 py-1.5 transition ${mode === m ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>
              {m === "keyword" ? "Keyword" : "Scrape URL"}
            </button>
          ))}
        </div>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => e.key === "Enter" && query && run()}
            placeholder={mode === "keyword" ? "e.g. math, games, study" : "e.g. github.com/some/proxy-list"}
            className="flex-1 rounded-lg border bg-background px-4 py-3 font-mono outline-none focus:ring-2 focus:ring-ring" />
          <button onClick={run} disabled={!query || !picked.length || !!busy}
            className="rounded-lg bg-primary px-6 py-3 font-semibold text-primary-foreground transition hover:opacity-90 disabled:opacity-40">
            {busy === "scrape" ? "Scraping…" : busy === "check" ? "Checking…" : "Scrape & Check"}
          </button>
        </div>

        <div className="mt-5">
          <div className="mb-2 flex items-center justify-between font-mono text-xs text-muted-foreground">
            <span>FILTERS</span><span>{picked.length}/{MAX}</span>
          </div>
          <div className="flex flex-wrap gap-2">
            {filters.map((f) => {
              const on = picked.includes(f.id);
              const locked = !on && picked.length >= MAX;
              return (
                <button key={f.id} onClick={() => toggle(f.id)} disabled={locked}
                  className={`rounded-full border px-3 py-1 text-sm transition ${on ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:border-accent"} ${locked ? "opacity-30" : ""}`}>
                  {f.name}
                </button>
              );
            })}
            {!filters.length && <span className="text-sm text-muted-foreground">Loading filters…</span>}
          </div>
        </div>
        {err && <p className="mt-4 text-sm text-destructive">{err}</p>}
      </section>

      {domains.length > 0 && (
        <section className="mt-8">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <p className="font-mono text-sm text-muted-foreground">
              {domains.length} live · <span className="text-success">{cleanCount} fully unblocked</span>
            </p>
            <div className="flex gap-2">
              <button onClick={() => setOnlyClean((v) => !v)} className="rounded-md border px-3 py-1 text-sm">
                {onlyClean ? "Show all" : "Only unblocked"}
              </button>
              <button onClick={() => navigator.clipboard.writeText(rows.filter((r) => r.clean).map((r) => r.domain).join("\n"))}
                className="rounded-md border px-3 py-1 text-sm">Copy unblocked</button>
            </div>
          </div>
          <ul className="space-y-2">
            {rows.map((d) => (
              <li key={d.domain} className={`rounded-xl border bg-card p-4 ${d.clean ? "border-primary/60" : ""}`}>
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <a href={`https://${d.domain}`} target="_blank" rel="noreferrer" className="font-mono font-semibold hover:text-primary">{d.domain}</a>
                  <span className="font-mono text-xs text-muted-foreground">
                    {d.registrar ?? "—"}{d.created ? ` · ${d.created.slice(0, 10)}` : ""}
                  </span>
                </div>
                <div className="mt-2 flex flex-wrap gap-2">
                  {d.r.length === 0 && busy === "check" && <span className="text-xs text-muted-foreground">checking…</span>}
                  {d.r.map((x) => (
                    <span key={x.filter} title={x.category ?? ""}
                      className={`rounded-md px-2 py-0.5 font-mono text-xs ${x.status === "unblocked" ? "bg-primary/15 text-success" : x.status === "blocked" ? "bg-destructive/15 text-destructive" : "bg-muted text-muted-foreground"}`}>
                      {name(x.filter)}: {x.status}
                    </span>
                  ))}
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </main>
  );
}
