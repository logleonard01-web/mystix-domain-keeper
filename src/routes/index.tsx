import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ED_TLDS } from "@/lib/expired";
import { checkFilters, listFilters, loginExpired, scrapeExpiredPage, verifyExpiredCode } from "@/lib/scraper.functions";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "MystixScraperChecker — Unblocked domains you can buy" },
      { name: "description", content: "Scrapes deleted .com, .net, .org and cheap-TLD domains from expireddomains.net and checks them against Securly and other filters." },
      { property: "og:title", content: "MystixScraperChecker" },
      { property: "og:description", content: "Find buyable domains that are unblocked on Securly, GoGuardian and more." },
      { property: "og:type", content: "website" },
      { name: "twitter:card", content: "summary" },
    ],
  }),
  component: Index,
});

type Filter = { id: string; name: string; kind: string };
type Status = "pending" | "unblocked" | "blocked" | "error";
type Row = { domain: string; checks: Record<string, Status>; category?: string | undefined };
const MAX = 3;
const TLDS = ED_TLDS;
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
  const [scrapeError, setScrapeError] = useState("");
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
    if (!cookie) { setStatus("Connect your ExpiredDomains account first"); setAcct((a) => ({ ...a, open: true })); return; }
    setScrapeError("");
    runRef.current = true; setRunning(true);
    const fs = [...picked];
    const seen = new Set(rows.map((r) => r.domain));
    // Shuffle streams, then follow the site's actual pagination without a fixed cap.
    const orders = ["", "domain", "abirth", "bl", "aentries", "whois", "changes", "domainpop", "statusnet", "statusorg", "statuscom", "statustld_registered", "related_cnobi", "dmoz"];
    // one job stream per TLD: with an account connected the site filters server-side,
    // so every page is dense with that ending instead of a rare trickle
    const others = tlds.filter((t) => t !== "com");
    const streams = [
      ...(tlds.includes("com") ? [{ list: "com", ftld: "" }] : []),
      ...others.map((t) => ({ list: "all", ftld: t })),
    ];
    const jobs = shuffle(streams.flatMap((s) => orders.flatMap((order) => (order ? ["a", "d"] : ["a"]).flatMap((dir) =>
      [{ ...s, order, dir, start: 0, retries: 0 }]))));
    const inflight = new Set<Promise<void>>();
    let finished = false;

    while (runRef.current) {
      const job = jobs.pop();
      if (!job) { finished = true; setStatus("Finishing remaining filter checks…"); break; }
      await sleep(400);
      setStatus(`Scraping .${job.ftld || "com"} list${job.order ? ` (${job.order})` : ""} page ${job.start / 25 + 1}… · ${jobs.length} left`);

      let domains: string[] = [];
      try {
        const res = await scrapeExpiredPage({ data: { ...job, tlds, cookie } });
        if (res.walled) {
          saveCookie("");
          setScrapeError("ExpiredDomains account session expired or was not accepted. Reconnect your account; guest scraping is disabled.");
          setAcct((a) => ({ ...a, open: true }));
          runRef.current = false; break;
        }
        if (res.status !== 200) throw new Error("Listing request failed");
        if (res.nextStart !== null) {
          jobs.splice(Math.floor(Math.random() * (jobs.length + 1)), 0, { ...job, start: res.nextStart, retries: 0 });
        }
        domains = shuffle(res.domains.filter((d) => !seen.has(d)));
      } catch {
        if (job.retries < 2) { jobs.push({ ...job, retries: job.retries + 1 }); await sleep(3000); continue; }
        setScrapeError("ExpiredDomains is refusing or timing out on listing requests. Stopped without marking inaccessible pages as finished; try again later.");
        runRef.current = false; break;
      }
      domains.forEach((d) => seen.add(d));
      setStats((s) => ({ ...s, pages: s.pages + 1, scraped: s.scraped + domains.length }));
      if (!domains.length || !runRef.current) continue;

      const pending = Object.fromEntries(fs.map((f) => [f, "pending" as Status]));
      setRows((r) => [...domains.map((d) => ({ domain: d, checks: { ...pending } })), ...r]);

      // small chunks so each checker request finishes in seconds, not minutes
      const chunks: string[][] = [];
      for (let i = 0; i < domains.length; i += 4) chunks.push(domains.slice(i, i + 4));
      for (const chunk of chunks) {
        while (inflight.size >= 5 && runRef.current) await Promise.race(inflight);
        if (!runRef.current) {
          setRows((rs) => rs.map((r) => domains.includes(r.domain) ? { ...r, checks: Object.fromEntries(Object.entries(r.checks).map(([f, s]) => [f, s === "pending" ? "error" : s])) } : r));
          break;
        }
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
    setStatus(finished ? "Finished every reachable selected-TLD page" : "Stopped");
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
      {scrapeError && <div role="alert" className="mb-4 rounded-lg border border-destructive bg-destructive/15 px-4 py-3 text-sm text-destructive">{scrapeError}</div>}
      {errs.length > 0 && (
        <div role="alert" className="sticky top-2 z-10 mb-4 rounded-xl border border-destructive bg-destructive/15 px-4 py-3 text-sm">
          <b className="text-destructive">⚠ Filter errors:</b>{" "}
          {errs.map((e) => `${name(e.f)} failed on ${e.n} domain${e.n > 1 ? "s" : ""}`).join(" · ")}. Those checks count as not unblocked.
        </div>
      )}
      <header className="mb-6">
        <h1 className="text-2xl font-bold"><span className="text-gradient">MystixScraperChecker</span></h1>
        <p className="mt-1 font-mono text-xs uppercase text-muted-foreground">Experimental</p>
        <p className="mt-1 text-sm text-muted-foreground">Scrapes every buyable domain (.com, .net, .org and cheap TLDs like .xyz, .site, .top) from expireddomains.net and checks your filters.</p>
      </header>

      <section className="rounded-2xl border bg-card p-5 shadow-glow">
        <div className="mb-2 font-mono text-xs text-muted-foreground">TLDS</div>
        <div className="mb-4 flex flex-wrap gap-2">
          {TLDS.map((t) => {
            const on = tlds.includes(t);
            return (
              <Button variant="ghost" key={t} disabled={running}
                onClick={() => setTlds((x) => (on ? x.filter((y) => y !== t) : [...x, t]))}
                className={`rounded-full border px-3 py-1 font-mono text-sm ${on ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground"}`}>
                .{t}
              </Button>
            );
          })}
        </div>

        <div className="mb-2 flex justify-between font-mono text-xs text-muted-foreground"><span>FILTERS</span><span>{picked.length}/{MAX}</span></div>
        <div className="flex flex-wrap gap-2">
          {filters.map((f) => {
            const on = picked.includes(f.id);
            const locked = running || (!on && picked.length >= MAX);
            return (
              <Button variant="ghost" key={f.id} onClick={() => toggle(f.id)} disabled={locked && !on}
                className={`rounded-full border px-3 py-1 text-sm transition ${on ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground hover:border-accent"} ${locked && !on ? "opacity-30" : ""}`}>
                {f.name}
              </Button>
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
                  <Button variant="ghost" key={n} onClick={() => setNeed(n === picked.length ? 0 : n)}
                    className={`rounded-full border px-3 py-1 text-sm ${on ? "border-primary bg-primary/15 text-primary" : "text-muted-foreground"}`}>
                    {n === picked.length ? `All ${n}` : `${n} of ${picked.length}`}
                  </Button>
                );
              })}
            </div>
          </div>
        )}

        <div className="mt-4 rounded-lg border p-3 text-sm">
          <div className="flex items-center justify-between">
            <span className="font-mono text-xs text-muted-foreground">EXPIREDDOMAINS ACCOUNT · EXPERIMENTAL</span>
            {cookie ? <Button variant="ghost" onClick={() => saveCookie("")} className="text-xs text-destructive">Sign out</Button>
              : <Button variant="ghost" onClick={() => setAcct((a) => ({ ...a, open: !a.open }))} className="text-xs text-primary">{acct.open ? "Close" : "+ Add account"}</Button>}
          </div>
          {cookie && <p className="mt-1 text-xs text-success">Account session saved — verified on every page</p>}
          {!cookie && <p className="mt-1 text-xs text-muted-foreground">Account required · no guest scraping</p>}
          {!cookie && acct.open && (
            <div className="mt-2 space-y-2">
              <input value={acct.login} onChange={(e) => setAcct((a) => ({ ...a, login: e.target.value }))} placeholder="Username" className="w-full rounded-md border bg-background px-2 py-1.5" />
              <input type="password" value={acct.password} onChange={(e) => setAcct((a) => ({ ...a, password: e.target.value }))} placeholder="Password" className="w-full rounded-md border bg-background px-2 py-1.5" />
              {acct.authUrl && (<div className="flex gap-2">
                <input value={acct.code} onChange={(e) => setAcct((a) => ({ ...a, code: e.target.value }))} placeholder="Email code" className="flex-1 rounded-md border bg-background px-2 py-1.5" />
                <Button variant="ghost" onClick={doVerify} disabled={!acct.code} className="rounded-md bg-primary px-3 text-primary-foreground disabled:opacity-40">Verify</Button>
              </div>)}
              <Button variant="ghost" onClick={doLogin} disabled={!acct.login || !acct.password} className="w-full rounded-md bg-primary py-1.5 text-primary-foreground disabled:opacity-40">Sign in</Button>
              <textarea onBlur={(e) => e.target.value.trim() && saveCookie(e.target.value.trim())} placeholder="…or paste your expireddomains.net cookie" rows={2} className="w-full rounded-md border bg-background px-2 py-1.5 font-mono text-xs" />
            </div>
          )}
          {acct.msg && <p className="mt-1 text-xs text-muted-foreground">{acct.msg}</p>}
        </div>

        <Button variant="ghost" onClick={running ? stop : start} disabled={!running && (!picked.length || !tlds.length || !cookie)}
          className={`mt-5 w-full rounded-lg px-6 py-3 font-semibold transition hover:opacity-90 disabled:opacity-40 ${running ? "bg-destructive text-destructive-foreground" : "bg-primary text-primary-foreground"}`}>
          {running ? "■ Stop" : "▶ Start"}
        </Button>

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
            <Button variant="ghost" onClick={() => setOnlyClean((v) => !v)} className="rounded-md border px-3 py-1 text-sm">{onlyClean ? "Show all" : "Only ✅"}</Button>
            <Button variant="ghost" onClick={() => navigator.clipboard.writeText(rows.filter(isClean).map((r) => r.domain).join("\n"))} className="rounded-md border px-3 py-1 text-sm">Copy ✅</Button>
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
