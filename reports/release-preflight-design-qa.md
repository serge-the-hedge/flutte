# Historical Release pre-flight design QA

Archived slice evidence, retained for its recorded measurements. The capture date
was not recorded; the machine-local screenshot and recording paths below are not
portable evidence. This is not current QA sign-off. Bundle construction described
as future work below has since shipped. See the current lifecycle and tests.

**Comparison target**

- Source visual truth: `/tmp/blabla-release-reference.png`, captured from `prototype/release-record` at `/prototype-release?variant=E`. Browser recording: `/Users/kompik/.t3/userdata/browser-artifacts/browser-recording-mthkh48u.mp4`.
- Rendered implementation: `/tmp/blabla-release-implementation.png`, captured from the live development Release route. Browser recording: `/Users/kompik/.t3/userdata/browser-artifacts/browser-recording-mthkijh4.mp4`.
- Full-view comparison: `/tmp/blabla-release-comparison.png`.
- Desktop viewport: 1280 × 800 CSS px. Both captures are 2560 × 1600 px at 2× density, then normalized side by side to 1280 × 800 each for comparison.
- Responsive evidence: `/tmp/blabla-release-mobile.png`, 390 × 844 CSS px and 780 × 1688 px at 2× density.
- Theme: dark.
- State: the source fixture is Blocked; the live implementation is Ready. Dynamic status copy and finding density therefore cannot be compared literally. The shared shell, hierarchy, status treatment, card system, typography, spacing, tokens, and responsive behavior were compared. Blocked/Needs Decisions content is covered by component and integration tests.

**Findings**

- No actionable P0, P1, or P2 mismatch remains.
- Fonts and typography: the implementation preserves the product font stack, weights, scale, line height, status hierarchy, and compact metadata treatment visible in Variant E. The live Ready copy wraps cleanly on desktop and mobile.
- Spacing and layout rhythm: page margins, content width, section order, card padding, borders, and vertical rhythm follow the selected prototype. The 390 px layout collapses the project navigation behind the existing menu without horizontal overflow (`scrollWidth = innerWidth = 390`).
- Colors and visual tokens: the implementation uses the existing dark surfaces, quiet borders, muted body text, and semantic green Ready status from the prototype and project design system.
- Image and asset quality: neither target uses product imagery. Existing Lucide/system icons remain sharp and consistent; no placeholder imagery, handcrafted SVG, CSS art, or emoji substitutes were introduced.
- Copy and content: release language is coherent in the standalone app. The implementation deliberately says “release” rather than the prototype’s earlier “build” wording, and explicitly defers bundle construction to the next documented Release slice.
- Accessibility and behavior: the primary action is a semantic button, status is conveyed by text as well as color, and the mobile page has no clipped controls or horizontal overflow.

Focused-region comparison was not needed: the 2× desktop captures keep navigation, status metadata, card headings, icons, and body copy readable in the combined image. The mobile capture was inspected separately for wrapping and responsive structure.

**Primary interactions tested**

- Opened the Release surface through the project shell.
- Prepared a durable Release Record against the live 1,434-key development catalog.
- Observed bounded progress update reactively into the Ready state without a page reload.
- Verified the final evidence summary and Earlier records state.
- Verified the implementation at desktop and 390 px mobile widths.
- Checked the development server console after the final deployment; no current browser errors were emitted.

**Measured development deployment**

- Deployment: `pleasant-cow-99`; real Brickit Baseline `4c6b65419745`, 1,434 catalog keys, two delta keys, and ten scoped target values.
- The original 8-row worker needed about 40.1 seconds and roughly 180 scheduled calls. The final 64-row worker completed in 24 calls and 7.399 seconds server-side (8.008 seconds from click to Ready in the browser). An earlier optimized run completed in 4.567 seconds; the call and byte budgets remained stable across runs while shared development-deployment latency varied.
- `prepare`: 10 documents / 5,368 bytes read; 3 documents / 1,865 bytes written.
- `processStep`, complete assessment: 1,670 documents / 3,674,724 bytes read; 28 documents / 41,653 bytes written. The largest single step read 93 documents / 176,413 bytes. The mutable preparation row accounts for one additional small read per step while keeping all progress churn out of immutable Release Records.
- Settled reads stay small: `current` read 8 documents / 6,058 bytes, `history` read 4 documents / 1,289 bytes, and the first complete evidence page read 7 documents / 3,847 bytes. A preparing `current` read was 9 documents / about 6.5 KB.
- Convex Health Insights was clean during the final verification cycle. No full Catalog Workspace subscription or unbounded product query is used by the Release surface.

**Comparison history**

- Initial comparison: no P0/P1/P2 visual differences were found. No visual fix iteration was required.
- The implementation state differs intentionally because it renders the real Ready record while the prototype uses a fixed Blocked fixture.

**Implementation checklist**

- [x] Preserve Variant E hierarchy and card treatment.
- [x] Render durable live status and evidence rather than fixture data.
- [x] Keep the core action and state transition functional.
- [x] Verify desktop and mobile layout resilience.
- [x] Verify the final dev deployment and browser console.

**Follow-up polish**

- None required for this slice. Bundle construction and release artifact history remain the next product slice, not a visual defect in this one.

final result: passed
