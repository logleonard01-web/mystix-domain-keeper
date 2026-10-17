<!-- LOVABLE:BEGIN -->
> [!IMPORTANT]
> This project is connected to [Lovable](https://lovable.dev). Avoid rewriting
> published git history — force pushing, or rebasing/amending/squashing commits
> that are already pushed — as it rewrites history on Lovable's side and the
> user will likely lose their project history.
>
> Commits you push to the connected branch sync back to Lovable and show up in
> the editor, so keep the branch in a working state.
<!-- LOVABLE:END -->

- Keep external filter adapters and fallback orchestration in `src/lib/filter-checker.ts` with bundled non-secret category data; this isolates provider formats and enables failure tests without network access.
- Keep ExpiredDomains session detection and pagination parsing in `src/lib/expired.ts`; both server enforcement and tests must use these shared rules.
- Discover subsequent listing offsets from returned pagination links, never a guessed maximum; this avoids silently truncating account-visible lists.
- Never import repository-embedded credentials or customer identifiers; unsupported credential-bound adapters use LLLogan until authorized service access is configured.
