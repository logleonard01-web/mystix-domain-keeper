import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { checkFilters, listFilters, loginExpired, scrapeExpiredPage, verifyExpiredCode } from "@/lib/scraper.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MystixScraperChecker — Unblocked domains you can buy" },
      { name: "description", content: "Scrapes deleted .com, .net, .org and cheap-TLD domains from expireddomains.net and checks them against Securly and other filters." },
      { property: "og:title", content: "MystixScraperChecker" },
      { property: "og:description", content: "Find buyable domains that are unblocked on Securly, GoGuardian and more." },
    ],
  }),
  component: Index,
});

type Filter = { id: string; name: string; kind: string };
type Status = "pending" | "unblocked" | "blocked" | "error";
type Row = { domain: string; checks: Record<string, Status>; category?: string | undefined };
const MAX = 3;
const TLDS = ["com", "net", "org", "xyz", "online", "site", "store", "shop", "top", "fun", "space", "club", "info", "biz", "icu", "lol", "website", "tech", "pw", "cc", "us", "io", "co", "me"];
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
  const [tlds, setTlds] = useState<string[]>(["com", "net", "org", "xyz", "online", "site", "shop", "top"]);
  const [rows, setRows] = useState<Row[]>([]);
  const [running, setRunning] = useState(false);
  const [status, setStatus] = useState("Idle");
  const [stats, setStats] = useState({ pages: 0, scraped: 0, checked: 0, clean: 0 });
  const [onlyClean, setOnlyClean] = useState(false);
  const [need, setNeed] = useState(0); // 0 = all picked filters
  const runRef = useRef(false);
  const [cookie, setCookie] = useState("");
  const [acct, setAcct] = useState({ login: "", password: "", open: false, msg: "", code: "", authUrl: "", pend: "" });
  useEffect(() => { setCookie(localStorage.getItem("ed_cookie") ?? ""); }, []);
  const saveCookie = (c: string) => { setCookie(c); c ? localStorage.setItem("ed_cookie", c) : localStorage.removeItem("ed_cookie"); };
  async function doVerify() {
    setAcct((a) => ({ ...a, msg: "Verifying…" }));
    try {
      const r = await verifyExpiredCode({ data: { authUrl: acct.authUrl, cookie: acct.pend, code: acct.code } });
      if (r.ok) { saveCookie(r.cookie); setAcct((a) => ({ ...a, password: "", open: false, code: "", authUrl: "", pend: "", msg: "Signed in ✅" })); }
      else setAcct((a) => ({ ...a, msg: `${r.reason || "Code didn't work"} — press Sign in for a new code` }));
    } catch { setAcct((a) => ({ ...a, msg: "Code didn't work — try again" })); }
  }
  async function doLogin() {
    setAcct((a) => ({ ...a, msg: "Signing in…" }));
    try {
      const r = await loginExpired({ data: { login: acct.login, password: acct.password } });
      if (r.ok) { saveCookie(r.cookie); setAcct((a) => ({ ...a, login: "", password: "", open: false, msg: "Signed in ✅" })); }
      else if (r.needsCode) setAcct((a) => ({ ...a, authUrl: r.authUrl, pend: r.cookie, msg: "Enter the code expireddomains.net just emailed you" }));
      else setAcct((a) => ({ ...a, msg: r.reason || "Sign-in failed" }));
    } catch { setAcct((a) => ({ ...a, msg: "Sign-in failed — paste your cookie instead" })); }
  }

  useEffect(() => { listFilters().then((r) => setFilters(r.filters)).catch(() => {}); }, []);

  const toggle = (id: string) => !running &&
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX ? p : [...p, id]));

  async function start() {
    if (!picked.length || !tlds.length) return;
    runRef.current = true; setRunning(true);
    const fs = [...picked];
    const seen = new Set(rows.map((r) => r.domain));
    // every listing window a guest can reach: list × sort order × direction × page, in random order
    const orders = ["", "domain", "abirth", "bl", "aentries", "whois", "changes", "domainpop", "statusnet", "statusorg", "statuscom", "statustld_registered", "related_cnobi", "dmoz"];
    // one job stream per TLD: with an account connected the site filters server-side,
    // so every page is dense with that ending instead of a rare trickle
    const others = tlds.filter((t) => t !== "com");
    const streams = [
      ...(tlds.includes("com") ? [{ list: "com", ftld: "" }] : []),
      // guests can't use the site's TLD filter, so one shared unfiltered stream
      ...(cookie ? others.map((t) => ({ list: "all", ftld: t })) : others.length ? [{ list: "all", ftld: "" }] : []),
    ];
    const jobs = shuffle(streams.flatMap((s) => orders.flatMap((order) => (order ? ["a", "d"] : ["a"]).flatMap((dir) =>
      Array.from({ length: 13 }, (_, p) => ({ ...s, order, dir, start: p * 25 }))))));
    const empty = new Set<string>();
    const deep = new Set<string>();
    const inflight = new Set<Promise<void>>();

    while (runRef.current) {
      const job = jobs.pop();
      if (!job) { setStatus("Finished every page"); break; }
      const key = `${job.list}|${job.ftld}|${job.order}|${job.dir}`;
      if (empty.has(key) && job.start > 0) continue;
      await sleep(400);
      setStatus(`Scraping .${job.ftld || "com"} list${job.order ? ` (${job.order})` : ""} page ${job.start / 25 + 1}… · ${jobs.length} left`);

      let domains: string[] = [];
      try {
        const res = await scrapeExpiredPage({ data: { ...job, tlds, cookie } });
        if (res.walled) {
          jobs.push(job);
          setStatus("expireddomains.net is asking for a login — waiting 60s then retrying…");
          for (let i = 0; i < 60 && runRef.current; i++) await sleep(1000);
          continue;
        }
        if (res.loggedIn && job.start === 0 && !deep.has(key)) {
          deep.add(key);
          for (let p = 13; p < 400; p++) jobs.splice(Math.floor(Math.random() * (jobs.length + 1)), 0, { ...job, start: p * 25 });
        }
        if (!res.found) { empty.add(key); continue; }
        domains = shuffle(res.domains.filter((d) => !seen.has(d)));
      } catch { await sleep(3000); continue; }
      domains.forEach((d) => seen.add(d));
      setStats((s) => ({ ...s, pages: s.pages + 1, scraped: s.scraped + domains.length }));
      if (!domains.length || !runRef.current) continue;

      const pending = Object.fromEntries(fs.map((f) => [f, "pending" as Status]));
      setRows((r) => [...domains.map((d) => ({ domain: d, checks: { ...pending } })), ...r].slice(0, 5000));

      // small chunks so each checker request finishes in seconds, not minutes
      const chunks: string[][] = [];
      for (let i = 0; i < domains.length; i += 8) chunks.push(domains.slice(i, i + 8));
      for (const chunk of chunks) {
        while (inflight.size >= 5 && runRef.current) await Promise.race(inflight);
        if (!runRef.current) break;
        const job2 = (async () => {
          let results: { site: string; filter: string; status: string; category: string | null }[] = [];
          try { results = (await checkFilters({ data: { links: chunk, filters: fs } })).results; }
          catch { await sleep(3000); try { results = (await checkFilters({ data: { links: chunk, filters: fs } })).results; } catch {} }

          setRows((rs) => rs.map((row) => {
            if (!chunk.includes(row.domain)) return row;
            const checks = { ...row.checks };
            let category = row.category;
            for (const f of fs) {
              const r = results.find((x) => x.site === row.domain && x.filter === f);
              checks[f] = r?.status === "unblocked" ? "unblocked" : r?.status === "blocked" ? "blocked" : "error";
              if (r?.category) category = r.category;
            }
            return { ...row, checks, category };
          }));
          setStats((s) => ({ ...s, checked: s.checked + chunk.length }));
        })();
        inflight.add(job2); job2.finally(() => inflight.delete(job2));
      }
    }
    await Promise.all(inflight);
    runRef.current = false; setRunning(false);
    setStatus((s) => (s.startsWith("Finished") ? s : "Stopped"));
  }

  const stop = () => { runRef.current = false; setStatus("Stopping…"); };
  const name = (id: string) => filters.find((f) => f.id === id)?.name ?? id;
  const needN = need && need < picked.length ? need : picked.length;
  const isClean = (r: Row) => picked.filter((f) => r.checks[f] === "unblocked").length >= needN;
  const isDone = (r: Row) => picked.every((f) => r.checks[f] && r.checks[f] !== "pending");
  const doneRows = rows.filter(isDone);
  const cleanCount = doneRows.filter(isClean).length;
  const errs = picked.map((f) => ({ f, n: rows.filter((r) => r.checks[f] === "error").length })).filter((x) => x.n);
  const shown = onlyClean ? rows.filter(isClean) : rows;
  const pct = doneRows.length ? (cleanCount / doneRows.length) * 100 : 0;

  return (
    <main className="mx-auto max-w-2xl px-4 py-10">
      {errs.length > 0 && (
        <div role="alert" className="sticky top-2 z-10 mb-4 rounded-xl border border-destructive bg-destructive/15 px-4 py-3 text-sm">
          <b className="text-destructive">⚠ Filter errors:</b>{" "}
          {errs.map((e) => `${name(e.f)} failed on ${e.n} domain${e.n > 1 ? "s" : ""}`).join(" · ")}. Those checks count as not unblocked.
        </div>
      )}
      <header className="mb-6">
        <h1 className="text-2xl font-bold"><span className="text-gradient">MystixScraperChecker</span></h1>
        <p className="mt-1 text-sm text-muted-foreground">Scrapes every buyable domain (.com, .net, .org and cheap TLDs like .xyz, .site, .top) from expireddomains.net and checks your filters.</p>
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

        {picked.length > 1 && (
          <div className="mt-4">
            <div className="mb-2 font-mono text-xs text-muted-foreground">COUNT AS ✅ WHEN UNBLOCKED ON</div>
            <div className="flex flex-wrap gap-2">
              {Array.from({ length: picked.length }, (_, i) => i + 1).map((n) => {
                const on = needN === n;
                return (
                  <button key={n} onClick={() => setNeed(n === picked.length ? 0 : n)}
                    className={`rounded-full border px-3 py-1 text-sm ${on ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground"}`}>
                    {n === picked.length ? `All ${n}` : `${n} of ${picked.length}`}
                  </button>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-4 rounded-lg border p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-muted-foreground">EXPIREDDOMAINS ACCOUNT</span>
            {cookie ? <button onClick={() => saveCookie("")} className="text-xs text-destructive">Sign out</button>
              : <button onClick={() => setAcct((a) => ({ ...a, open: !a.open }))} className="text-xs text-primary">{acct.open ? "Close" : "+ Add account"}</button>}
          </div>
          {cookie && <p className="mt-1 text-xs text-success">Account connected — all pages unlocked</p>}
          {!cookie && acct.open && (
            <div className="mt-2 space-y-2">
              <input value={acct.login} onChange={(e) => setAcct((a) => ({ ...a, login: e.target.value }))} placeholder="Username" className="w-full rounded-md border bg-background px-2 py-1.5" />
              <input type="password" value={acct.password} onChange={(e) => setAcct((a) => ({ ...a, password: e.target.value }))} placeholder="Password" className="w-full rounded-md border bg-background px-2 py-1.5" />
              {acct.authUrl && (<div className="flex gap-2">
                <input value={acct.code} onChange={(e) => setAcct((a) => ({ ...a, code: e.target.value }))} placeholder="Email code" className="flex-1 rounded-md border bg-background px-2 py-1.5" />
                <button onClick={doVerify} disabled={!acct.code} className="rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-40">Verify</button>
              </div>)}
              <button onClick={doLogin} disabled={!acct.login || !acct.password} className="w-full rounded-md bg-primary py-1.5 text-primary-foreground disabled:opacity-40">Sign in</button>
              <textarea onBlur={(e) => e.target.value.trim() && saveCookie(e.target.value.trim())} placeholder="…or paste your expireddomains.net cookie" rows={2} className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs" />
            </div>
          )}
          {acct.msg && <p className="mt-1 text-xs text-muted-foreground">{acct.msg}</p>}
        </div>

        <button onClick={running ? stop : start} disabled={!picked.length || !tlds.length}
          className={`mt-5 w-full rounded-lg px-6 py-3 font-semibold transition hover:opacity-90 disabled:opacity-40 ${running ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}>
          {running ? "■ Stop" : "▶ Start"}
        </button>

        <div className="mt-4 flex h-1.5 overflow-hidden rounded-full bg-muted">
          <i className="block h-full bg-success transition-all duration-700" style={{ width: `${pct}%` }} />
          <i className="block h-full bg-destructive transition-all duration-700" style={{ width: `${doneRows.length ? 100 - pct : 0}%` }} />
        </div>
        <p className="mt-3 text-center font-mono text-xs text-muted-foreground">
          {running && <span className="pulse mr-2 inline-block scale-50 align-middle" />}{status}
        </p>
        <p className="mt-1 text-center text-sm font-semibold">
          <span className="text-success">{cleanCount} unblocked</span>
          <span className="mx-2 text-muted-foreground">·</span>
          <span className="text-destructive">{doneRows.length - cleanCount} blocked</span>
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
              const done = isDone(r);
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
