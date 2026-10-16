import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { checkFilters, listFilters, scrapeExpiredPage } from "@/lib/scraper.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MystixScraperChecker — Unblocked domains you can buy" },
      { name: "description", content: "Scrapes deleted .com/.net/.org domains from expireddomains.net and checks them against Securly and other filters." },
      { property: "og:title", content: "MystixScraperChecker" },
      { property: "og:description", content: "Find buyable domains that are unblocked on Securly, GoGuardian and more." },
    ],
  }),
  component: Index,
});

type Filter = { id: string; name: string; kind: string };
type Status = "pending" | "unblocked" | "blocked" | "error";
type Row = { domain: string; checks: Record<string, Status>; category?: string };
const MAX = 3;
const TLDS = ["com", "net", "org"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const shuffle = <T,>(a: T[]) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j] as T, a[i] as T]; } return a; };

function Mark({ s }: { s: Status }) {
  if (s === "pending") return <span className="pulse" />;
  if (s === "unblocked")
    return <svg className="mk ok" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M7.4 12.5l3.1 3.1 6.4-7.2" /></svg>;
  if (s === "blocked")
    return <svg className="mk bad" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path className="p1" d="M8.7 8.7l6.6 6.6" /><path className="p2" d="M15.3 8.7l-6.6 6.6" /></svg>;
  return <svg className="mk err" viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path className="p1" d="M12 6.9v5.9" /><rect className="dot" x="10.65" y="15.5" width="2.7" height="2.7" rx="1.35" /></svg>;
}

function Index() {
  const [filters, setFilters] = useState<Filter[]>([]);
  const [picked, setPicked] = useState<string[]>(["securly", "goguardianv3", "lightspeed"]);
  const [tlds, setTlds] = useState<string[]>(TLDS);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [stats, setStats] = useState({ pages: 0, scraped: 0, checked: 0, clean: 0 });
  const [onlyClean, setOnlyClean] = useState(false);
  const runRef = useRef(false);

  useEffect(() => { listFilters().then((r) => setFilters(r.filters)).catch(() => {}); }, []);

  const toggle = (id: string) => !running &&
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX ? p : [...p, id]));

  async function start() {
    if (!picked.length || !tlds.length) return;
    runRef.current = true; setRunning(true);
    const fs = [...picked];
    const seen = new Set(rows.map((r) => r.domain));
    // per-TLD: estimated last page + visited pages, walked in random order
    const state: Record<string, { max: number; done: Set<number> }> = {};
    tlds.forEach((t) => (state[t] = { max: 4000, done: new Set() }));

    while (runRef.current) {
      const open = tlds.filter((t) => state[t]!.done.size < state[t]!.max);
      if (!open.length) { setStatus("Finished every page"); break; }
      const tld = open[Math.floor(Math.random() * open.length)]!;
      const st = state[tld]!;
      let page = Math.floor(Math.random() * st.max);
      while (st.done.has(page)) page = (page + 1) % st.max;
      st.done.add(page);
      setStatus(`Scraping .${tld} page ${page + 1}…`);

      let domains: string[] = [];
      try {
        const res = await scrapeExpiredPage({ data: { tld, start: page * 25 } });
        if (!res.found && res.status === 200) { st.max = Math.max(1, page); continue; }
        domains = shuffle(res.domains.filter((d) => !seen.has(d)));
      } catch { await sleep(3000); continue; }
      domains.forEach((d) => seen.add(d));
      setStats((s) => ({ ...s, pages: s.pages + 1, scraped: s.scraped + domains.length }));
      if (!domains.length || !runRef.current) continue;

      const pending = Object.fromEntries(fs.map((f) => [f, "pending" as Status]));
      setRows((r) => [...domains.map((d) => ({ domain: d, checks: { ...pending } })), ...r].slice(0, 500));
      setStatus(`Checking ${domains.length} buyable .${tld} domains…`);

      let results: { site: string; filter: string; status: string; category: string | null }[] = [];
      try { results = (await checkFilters({ data: { links: domains, filters: fs } })).results; }
      catch { setStatus("Checker busy, waiting…"); await sleep(10000); }

      const clean = domains.filter((d) => fs.every((f) => results.some((x) => x.site === d && x.filter === f && x.status === "unblocked"))).length;
      setRows((rs) => rs.map((row) => {
        if (!domains.includes(row.domain)) return row;
        const checks = { ...row.checks };
        let category = row.category;
        for (const f of fs) {
          const r = results.find((x) => x.site === row.domain && x.filter === f);
          checks[f] = r?.status === "unblocked" ? "unblocked" : r?.status === "blocked" ? "blocked" : "error";
          if (r?.category) category = r.category;
        }
        return { ...row, checks, category };
      }));
      setStats((s) => ({ ...s, checked: s.checked + domains.length, clean: s.clean + clean }));
      await sleep(1200);
    }
    runRef.current = false; setRunning(false);
    setStatus((s) => (s.startsWith("Finished") ? s : "Stopped"));
  }

  const stop = () => { runRef.current = false; setStatus("Stopping…"); };
  const name = (id: string) => filters.find((f) => f.id === id)?.name ?? id;
  const isClean = (r: Row) => picked.every((f) => r.checks[f] === "unblocked");
  const shown = onlyClean ? rows.filter(isClean) : rows;
  const pct = stats.checked ? (stats.clean / stats.checked) * 100 : 0;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      <header className="mb-6">
        <h1 className="text-2xl font-bold"><span className="text-gradient">MystixScraperChecker</span></h1>
        <p className="mt-1 text-sm text-muted-foreground">Scrapes every buyable .com / .net / .org from expireddomains.net and checks your filters.</p>
      </header>

      <section className="rounded-2xl border bg-card p-5 shadow-glow">
        <div className="mb-2 font-mono text-xs text-muted-foreground">TLDS</div>
        <div className="mb-4 flex gap-2">
          {TLDS.map((t) => {
            const on = tlds.includes(t);
            return (
              <button key={t} disabled={running}
                onClick={() => setTlds((x) => (on ? x.filter((y) => y !== t) : [...x, t]))}
                className={`rounded-full border px-3 py-1 font-mono text-sm ${on ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground"}`}>
                .{t}
              </button>
            );
          })}
        </div>

        <div className="mb-2 flex justify-between font-mono text-xs text-muted-foreground"><span>FILTERS</span><span>{picked.length}/{MAX}</span></div>
        <div className="flex flex-wrap gap-2">
          {filters.map((f) => {
            const on = picked.includes(f.id);
            const locked = running || (!on && picked.length >= MAX);
            return (
              <button key={f.id} onClick={() => toggle(f.id)} disabled={locked && !on}
                className={`rounded-full border px-3 py-1 text-sm transition ${on ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:border-accent"} ${locked && !on ? "opacity-30" : ""}`}>
                {f.name}
              </button>
            );
          })}
          {!filters.length && <span className="text-sm text-muted-foreground">Loading filters…</span>}
        </div>

        <button onClick={running ? stop : start} disabled={!picked.length || !tlds.length}
          className={`mt-5 w-full rounded-lg px-6 py-3 font-semibold transition hover:opacity-90 disabled:opacity-40 ${running ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}>
          {running ? "■ Stop" : "▶ Start"}
        </button>

        <div className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-muted">
          <i className="block h-full bg-success transition-all duration-700" style={{ width: `${pct}%` }} />
          <i className="block h-full bg-destructive transition-all duration-700" style={{ width: `${stats.checked ? 100 - pct : 0}%` }} />
        </div>
        <p className="mt-3 text-center font-mono text-xs text-muted-foreground">
          {running && <span className="pulse mr-2 inline-block scale-50 align-middle" />}{status}
        </p>
        <p className="mt-1 text-center text-sm font-semibold">
          <span className="text-success">{stats.clean} unblocked</span>
          <span className="mx-2 text-muted-foreground">·</span>
          <span className="text-destructive">{stats.checked - stats.clean} blocked</span>
          <span className="mx-2 text-muted-foreground">·</span>
          <span className="text-muted-foreground">{stats.pages} pages</span>
        </p>
      </section>

      {rows.length > 0 && (
        <section className="mt-6">
          <div className="mb-2 flex justify-end gap-2">
            <button onClick={() => setOnlyClean((v) => !v)} className="rounded-md border px-3 py-1 text-sm">{onlyClean ? "Show all" : "Only ✅"}</button>
            <button onClick={() => navigator.clipboard.writeText(rows.filter(isClean).map((r) => r.domain).join("\n"))} className="rounded-md border px-3 py-1 text-sm">Copy ✅</button>
          </div>
          <ul className="space-y-1.5">
            {shown.map((r) => {
              const done = picked.every((f) => r.checks[f] && r.checks[f] !== "pending");
              const clean = isClean(r);
              return (
                <li key={r.domain} className={`chk-row rounded-xl border bg-card px-3 py-2.5 ${done ? (clean ? "ok" : "bad") : ""}`}>
                  <div className="flex items-center gap-2">
                    <span>{done ? (clean ? "✅" : "❌") : "⏳"}</span>
                    <a href={`https://www.namecheap.com/domains/registration/results/?domain=${r.domain}`} target="_blank" rel="noreferrer"
                      className="truncate font-semibold hover:text-primary">{r.domain}</a>
                    {r.category && <span className="ml-auto max-w-[35%] truncate text-xs text-muted-foreground">{r.category}</span>}
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-3">
                    {picked.map((f) => (
                      <span key={f} className="flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className="flex h-[22px] w-[22px] items-center justify-center"><Mark s={r.checks[f] ?? "pending"} /></span>
                        {name(f)}
                      </span>
                    ))}
                  </div>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </main>
  );
}
