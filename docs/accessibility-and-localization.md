# Documentation accessibility and localization verification

Status: local browser, accessibility-tree, keyboard, and static-build evidence
Checked: 2026-08-05
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

The local production build was exercised with headless Chrome at the GitHub Pages
base path `/pactmark/` in both English and Turkish:

- 390 × 844 mobile: English landing page rendered at 390 px with 375 px document
  width and no horizontal overflow. Hero links retained the `/pactmark/en/` base.
- 1440 × 900 desktop: the language selector exposed one English/Türkçe control;
  selecting Türkçe navigated to `/pactmark/tr/`, set `lang="tr"`, and rendered the
  Turkish heading.
- Automated keyboard traversal sampled 18 Tab presses per locale and reached eight
  unique targets in a stable cycle. The localized skip link was first, followed by
  the home link, search, theme, language, and page actions; no keyboard trap was
  observed in this landing-page flow.
- Chrome's accessibility tree exposed one `main`, one `navigation`, and one heading
  landmark per locale, with no unnamed link, button, textbox, or combobox. The DOM
  likewise had one `h1`, one `main`, and no unnamed interactive control.
- Device-metric reflow surrogates at 720 CSS px with device scale factor 2 and
  360 CSS px with device scale factor 4 retained the main content and heading with
  no horizontal overflow. These exercise WCAG-equivalent viewport widths but are
  not recorded as proof of the browser UI's native zoom control.
- Search: the Turkish `Ara` button opened an accessible `dialog` containing an
  active `Ara` textbox.
- Browser console: zero warning or error records after the mobile, desktop,
  localization, search, and reflow flows.

Both locales used reduced-motion emulation and produced no browser console or page
errors. True 200%/400% browser-UI zoom and an auditory screen-reader session remain
manual checks; the accessibility-tree result is not represented as a screen-reader
compatibility certification.

## Manual keyboard and screen-reader procedure

For the remaining human verification, a reviewer must record browser, operating
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

Automated keyboard, semantic accessibility-tree, reduced-motion, and narrow-viewport
reflow evidence was recorded on 2026-08-05. No auditory screen-reader run or true
browser-UI high-zoom run has yet been recorded; those are explicit manual checks
rather than inferred successes.
