# Escalation Lab

Crisis simulations for teaching and research: FLASHPOINT:2027, a public crisis-origins exercise, and private research labs run with partner institutions.

**Site: [escalationlab.org](https://escalationlab.org/)** · **Play FLASHPOINT:2027: [escalationlab.org/flashpoint/](https://escalationlab.org/flashpoint/)**

## What is in this repository

This repository is the public website, served by GitHub Pages from its main branch with no build step: every file here is published.

| Path | What it is | Where it comes from |
|---|---|---|
| `index.html` | The Escalation Lab front page (brand kit, October 2026). Its inline scope SVG and animation CSS must not be altered or minified | Brand kit; head additions noted in the commit history |
| `site.css` | Shared design tokens and the parent header, footer and page styles | Taken from the front page's rules |
| `about.html`, `research.html`, `404.html` | Parent-brand inner pages | Edited here |
| `glossary.html`, `instructor.html`, `sources.html`, `index-2.html` | Redirects from old addresses to `/flashpoint/` | Edited here |
| `enter-lab.js` | The front page's access-code handler for the sealed research lab | Edited here |
| `favicon.*`, `apple-touch-icon.png`, `icon-*.png`, `site.webmanifest`, `og-image.png`, `og-flashpoint.png` | Icons, manifest and share cards | Brand kit |
| `brand/` | Logos and marks (`svg/`, `png/`) | Brand kit; do not edit the SVGs |
| `flashpoint/` | FLASHPOINT:2027, built (obfuscated), with its own icons | The game's repository, `flashpoint-2027`: run its build and copy the output here |
| `lab/` | The TIN PROPHET lab's pages. They hold no scenario text: content reaches a device only from the lab server, after a valid code | The private lab repository: `LAB_API_BASE=https://lab-api.escalationlab.org npm run build`, then copy `dist/lab/` here |
| `CNAME`, `LICENSE.md`, `CITATION.cff` | Site settings and terms | Edited here |

The lab's server, scenarios and research documents are not published here; the server runs at `lab-api.escalationlab.org` from a separate private repository.

An Escalation Lab project by Hallam Burnapp (PhD researcher, University of Aberdeen). © 2026 Hallam Burnapp. All rights reserved — see `LICENSE.md`.
