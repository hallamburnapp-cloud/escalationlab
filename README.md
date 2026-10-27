# Escalation Lab

Crisis simulations for teaching and research: FLASHPOINT:2027, a public crisis-origins exercise, and private research labs run with partner institutions.

**Site: [escalationlab.org](https://escalationlab.org/)** · **Play FLASHPOINT:2027: [escalationlab.org/flashpoint/](https://escalationlab.org/flashpoint/)**

## What is in this repository

This repository is the public website, served by GitHub Pages from its main branch.

| Path | What it is | Where it comes from |
|---|---|---|
| `index.html`, `about.html`, `research.html`, `404.html`, `site.css` | The Escalation Lab hub and its public pages | Edited here |
| `glossary.html`, `instructor.html`, `sources.html` | Redirects from the game's old addresses to `/flashpoint/` | Edited here |
| `index.html` (script at the top) | Sends legacy exercise links (`/?seed=…&timer=…`) to `/flashpoint/` | Edited here |
| `flashpoint/` | FLASHPOINT:2027, built (obfuscated) | The game's own repository, `flashpoint-2027`: run its build, copy the output into `flashpoint/`, and point the pages' canonical and `og:url` addresses at `https://escalationlab.org/flashpoint/` |
| Icons, `og-image.png`, `CNAME`, `LICENSE.md`, `CITATION.cff` | Site assets | Edited here |

The private research labs are not published here. They run on the lab's own equipment at each session, from a separate private repository.

An Escalation Lab project by Hallam Burnapp (PhD researcher, University of Aberdeen). © 2026 Hallam Burnapp. All rights reserved — see `LICENSE.md`.
