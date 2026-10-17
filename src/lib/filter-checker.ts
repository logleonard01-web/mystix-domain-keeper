import blocksi from "./filter-data/blocksi.json";
import senso from "./filter-data/senso.json";
import cisco from "./filter-data/cisco.json";

export type FilterResult = { site: string; filter: string; status: "unblocked" | "blocked" | "error"; category: string | null; source?: string };
export const PUBLIC_FILTERS = [
  { id: "blocksi", name: "Blocksi", kind: "repository" },
  { id: "senso", name: "Senso", kind: "repository" },
  { id: "cisco", name: "Cisco Talos", kind: "repository" },
];
type Category = { name: string; cat: string; blocked: boolean };

export async function repositoryCheck(site: string, filter: string): Promise<FilterResult | null> {
  const endpoints: Record<string, string> = {
    blocksi: `https://service1.blocksi.net/getRating.json?url=${encodeURIComponent(site)}`,
    senso: `https://filtering.senso.cloud/filter/lookup?url=${encodeURIComponent(`https://${site}`)}`,
    cisco: `https://talosintelligence.com/cloud_intel/url_reputation?url=${encodeURIComponent(site)}`,
  };
  const endpoint = endpoints[filter];
  if (!endpoint) return null;
  try {
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) return null;
    const data = await response.json();
    let category: string;
    let blocked: boolean;
    if (filter === "blocksi") {
      const entry = (blocksi as Record<string, Category>)[String(data.Category)];
      if (!entry) return null;
      category = `${entry.cat}: ${entry.name}`; blocked = entry.blocked;
    } else if (filter === "senso") {
      if (!Array.isArray(data) || !data.length) return null;
      const entries = data.map((id) => (senso as Record<string, (string | boolean)[]>)[String(id)]);
      if (entries.some((entry) => !entry)) return null;
      category = entries.map((entry) => entry?.[0]).join(", ");
      blocked = entries.some((entry) => entry?.[1] === true);
    } else {
      const entries = data?.reputation?.aup_cat;
      if (!Array.isArray(entries) || !entries.length || entries.some((entry) => typeof entry.name !== "string")) return null;
      category = entries.map((entry) => entry.name).join(", ");
      blocked = entries.some((entry) => cisco.includes(entry.name));
    }
    return { site, filter, status: blocked ? "blocked" : "unblocked", category, source: "filterapis" };
  } catch { return null; }
}

type Primary = (site: string, filter: string) => Promise<FilterResult | null>;
type Fallback = (links: string[], filters: string[]) => Promise<FilterResult[]>;

export async function resolveFilterChecks(links: string[], filters: string[], primary: Primary, fallback: Fallback) {
  const results: FilterResult[] = [];
  const failed = new Map<string, string[]>();
  await Promise.all(filters.map(async (filter) => {
    const checks = await Promise.all(links.map(async (site) => {
      try { return await primary(site, filter); } catch { return null; }
    }));
    checks.forEach((check, i) => {
      const site = links[i];
      if (!site) return;
      if (check && (check.status === "blocked" || check.status === "unblocked")) results.push(check);
      else failed.set(filter, [...(failed.get(filter) ?? []), site]);
    });
  }));
  await Promise.all([...failed].map(async ([filter, sites]) => {
    // Small fallback requests avoid long-running bulk checks.
    for (let i = 0; i < sites.length; i += 4) {
      const chunk = sites.slice(i, i + 4);
      let recovered: FilterResult[] = [];
      try { recovered = await fallback(chunk, [filter]); } catch { /* explicit errors below */ }
      for (const site of chunk) {
        const result = recovered.find((r) => r.site === site && r.filter === filter && (r.status === "unblocked" || r.status === "blocked"));
        results.push(result ? { ...result, source: "LLLogan" } : { site, filter, status: "error", category: null });
      }
    }
  }));
  return results;
}