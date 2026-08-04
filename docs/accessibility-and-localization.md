# Documentation accessibility and localization verification

Status: local browser and static-build evidence  
Checked: 2026-08-04  
Compatibility: Pactmark 0.1.x

This record covers the generated Starlight documentation site. It is not a formal
accessibility certification and does not claim compatibility with every assistive
technology.

## Automated build checks

`pnpm docs:build` inspects every generated HTML page for document language, title,
viewport metadata, a main landmark, image alternatives, duplicate IDs, canonical
URLs, internal-link resolution, and unsafe link schemes. It also requires the
reduced-motion stylesheet, sitemap, search index, `robots.txt`, `llms.txt`, and the
package documentation index. The 2026-08-04 build produced 93 HTML pages with no
serious or critical finding in this static rule set.

`pnpm docs:translations` validates 13 required English/Turkish mappings, required
API terms, safety headings, and compatibility markers. This is a semantic checklist,
not evidence that every English page has a human-authored Turkish equivalent; the
site uses the English fallback for pages outside the required parity set.

## Browser flows

The local production build was exercised in the in-app Chromium browser at the
GitHub Pages base path `/pactmark/`:

- 390 × 844 mobile: English landing page rendered at 390 px with 375 px document
  width and no horizontal overflow. Hero links retained the `/pactmark/en/` base.
- 1440 × 900 desktop: the language selector exposed one English/Türkçe control;
  selecting Türkçe navigated to `/pactmark/tr/`, set `lang="tr"`, and rendered the
  Turkish heading.
- 720 × 900 reflow surrogate: the Turkish page had equal viewport and document
  widths, with no horizontal overflow.
- Search: the Turkish `Ara` button opened an accessible `dialog` containing an
  active `Ara` textbox.
- Browser console: zero warning or error records after the mobile, desktop,
  localization, search, and reflow flows.

The automation host did not apply browser zoom when the platform zoom shortcut was
sent, so true 200% browser-zoom behavior remains a manual release check. The 720 px
reflow result is recorded separately and must not be represented as 200% zoom proof.

## Manual keyboard and screen-reader procedure

Before a public documentation deployment, a reviewer must record browser, operating
system, screen reader, date, and results for this procedure:

1. With pointer input unused, press Tab and confirm the first visible focus target is
   the localized skip link; activate it and confirm focus moves to main content.
2. Traverse the header, search, theme, language, sidebar, content links, and pagination
   in a logical order with a visible focus indicator and no keyboard trap.
3. Open search, enter a query, traverse results, and close the dialog using only the
   keyboard. Confirm focus returns to the search trigger.
4. At 200% and 400% browser zoom, confirm content reflows without two-dimensional
   scrolling except where a code or data table intrinsically requires it.
5. With a screen reader, confirm the page title, language, landmark order, heading
   hierarchy, navigation labels, search-dialog state, selected language, code-block
   labels, link purpose, and warning/status text are announced meaningfully in both
   English and Turkish.
6. Enable reduced motion and confirm non-essential animation is removed.

No screen-reader run or true high-zoom run has yet been recorded. Those are explicit
release-readiness items rather than inferred successes.
