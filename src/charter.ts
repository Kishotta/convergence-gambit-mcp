/**
 * The LegendKeeper Architecture & Presentation Charter, embedded verbatim.
 *
 * Served by the `get_charter` tool so any Claude conversation connected to
 * this server can pull our authoritative conventions without needing the
 * Claude Project's files. When the charter changes, update this file and
 * redeploy — the source of truth is the markdown in the campaign project
 * until migration completes, then it becomes an LK article and this module
 * becomes a fetch.
 */

export const ARCHITECTURE_CHARTER = `# The Convergence Gambit — LegendKeeper Architecture & Presentation Charter

*This document records the settled architecture for presenting the campaign in LegendKeeper. It is the authoritative reference for how the project is organized, how content is layered for the two audiences, and the conventions that keep the wiki useful at the table and safe for players. Add it to project knowledge so future article work inherits these decisions.*

---

## 1. First principle: one world, two audiences

There is a single LegendKeeper world. There is **no shadow player-wiki**. Every piece of content is authored exactly once and assigned to one of two layers. Players see only the slice that has been revealed; the DM sees everything. This is what lets the same article serve both prep and play without duplication.

The architecture rests on the fact that LegendKeeper's visibility controls are clean enough to contain spoilers automatically. We are not hiding content by hand or maintaining parallel structures — the tool does the containment.

---

## 2. The visibility model

Secrecy can be set at four levels, each behaving intuitively:

| Level | Behavior when secret |
|---|---|
| **Element** | The player cannot see the element exists at all, including its nested children. |
| **Tab** | A secret tab on a visible element is completely invisible until specifically revealed. |
| **Wiki block** | A secret block inside a visible tab is silently omitted — the player sees no indication a secret is present. |
| **Map pin** | A hidden pin is invisible; and any un-hidden pin that links to a hidden element is also auto-hidden. |

**Cascade rule.** Revealing an element reveals its *non-secret* nested elements. Nested elements that are themselves marked secret stay hidden until revealed individually. This cascades as expected, and is what makes room-by-room dungeon reveals work: mark each room element secret, reveal the parent, then flip rooms on as the party enters them.

**Reveal ergonomics.** Elements reveal via an eyeball icon in the project hierarchy; blocks via a "Reveal Secret" context-menu option. Both are trivial to do live at the table.

**What does NOT leak.** Player search, tag indexes, backlinks, and player filters all respect visibility. A hidden element never surfaces through any of these. This is what makes the player-facing tooling (Section 6, Goal 2) work.

**The one accepted leak.** A link or auto-link in *visible* body text that points to a *hidden* element renders as a dead link. It reveals only that "a named thing significant enough to exist" is out there — nothing about it. This is accepted as minimal. The LegendKeeper author has teased a future change rendering these as plain text.

> **Crown-jewel mitigation.** For the campaign's highest-value secrets — the Convergence itself, Primus's true role, Shemeshka's endgame — route the name into a *secret block* rather than naming it in open body text, so not even a dead link appears until you choose.

---

## 3. The two layers

Every article is written for two audiences, and the split is strict.

**Operational layer — DM-only.** Hidden tabs and hidden elements. NPC Beliefs / Wants / Voice & Mannerisms / Sample Lines, tactics, stat blocks, quest connections, prep notes. Players never see this.

**Reveal layer — player-discoverable.** Visible tabs, plus secret blocks and secret pins flipped on at the table as the party earns them. Physical descriptions, public reputation, read-aloud text, discovered hooks.

**The reveal-layer test.** Before finishing any visible tab, ask: *if a player read this after encountering it, would it spoil anything?* If yes, it's in the wrong layer.

---

## 4. Keystone organizing principle: home vs. hook

An element is **homed** in exactly one place in the tree — the single location where it is authored and owns its detail. It is **hooked** from anywhere else it's relevant, via links, map pins, secret blocks, and tags.

Almost every "should this live under X or Y?" question dissolves once home and hook are separated. There is no need for all elements of the same *kind* to share a root, provided they are linked and tagged. Tags are the powerhouse here: a tag index can gather far-flung elements into one view regardless of where each is homed (all items the party holds, all Lower Ward locations, all live-thread NPCs).

This principle is why three early top-level folders were dissolved (Section 5).

---

## 5. Project hierarchy

### Current root

- **The Convergence Gambit** — campaign overview. Hosts the **Campaign Timeline** tab and the **Conspiracy Board** tab.
- **DM Dashboard** *(hidden)* — at-table cold-reference; see Goal 1.
- **Sigil**, **The Outlands**, **The Great Wheel** — geography. (Reveal state is a prep decision; only Material Plane and Arcadia currently revealed on the Wheel.)
- **NPCs** — world-mobile characters only. Location-bound NPCs nest under their location; flat NPCs live in a location's hidden tab.
- **Factions** — Athar, the Fated, Society of Sensation, Harmonium. Public reputation in the open; earned knowledge in secret blocks.
- **Plots** *(hidden)* — **Act articles** as structural containers; individual **adventures** nested inside them; **throughline subplots** (e.g. Morte's arc) as separate threads.
- **Sessions / Chronicle** — one element per session.
- **Magic Items**, **Monsters** *(hidden)* — reference holding folders.
- **Party** — one article per PC.
- **Idiomatic Design** *(hidden)* — meta notes on how to write elements.
- **Templates** — reusable article skeletons.

### Dissolved folders and where their contents go

| Former folder | Why dissolved | New home |
|---|---|---|
| **Encounters** | An encounter belongs with whatever triggers it. | Keyed encounter → its building. Roaming / random → its **ward**. Plot-triggered → its **Act or subplot**. Hooked everywhere it might land. |
| **Quests** | "Quest" did two jobs. | Location-rooted task (recover Zadara's painting, buy the Fortune's Wheel portal key) → secret block / sub-element on that location. Multi-location **adventure** (The Anvil's Son) → its **Act** in Plots, hooked from its start location (Anze's Anvil Smithy). |
| **Lore** | Junk drawer. | Shemeshka's-scheme WIP → a **throughline subplot** in Plots. "How Shemeshka operates" detail → her NPC article's hidden tabs. Setting-level facts → the relevant geography element's DM tab / secret block. |

---

## 6. How the four goals are served

**Goal 1 — DM prep and cold reference.** The operational layer plus the **DM Dashboard**, a hidden element whose tabs are nothing but **tag-index queries** ("NPCs with a live quest thread," "everything tagged \`act-1\`," "every Lower Ward location," "shops with a menu"). When the party blows past prep into a ward last touched a month ago, you filter the Dashboard instead of trawling memory. Backlinks are a second navigation tool: from any NPC, see every location and adventure they touch.

**Goal 2 — players never take notes.** Give players one visible element — **Field Notes** *(working name)* — whose tabs are tag-index blocks: *Places we've been*, *People we've met*, *Things we carry*. Because indexes respect visibility, the instant you reveal-and-tag an element, it auto-populates the players' notebook. Their notes build themselves as a side effect of your reveals; they search and filter from there, on their phones, seeing only what they've discovered.

> **Tagging discipline.** Any tag applied to a *revealed* element must be player-safe in its name, because tags are visible on visible elements. Keep DM-only conceptual grouping (\`shemeshka-network\`, \`act2-payoff\`) confined to hidden elements/tabs; use a clean public vocabulary (\`shop\`, \`athar\`, \`lower-ward\`, \`met\`) on anything the party can see.

**Goal 3 — session notes.** One element per session, two tabs: a player-facing **recap** in the reveal layer, and a **secret DM tab** with after-action notes and what to reveal next. Name-link NPCs, locations, and items in the recap so they feed each article's backlinks. Each session is also an event on the Campaign Timeline, dated to in-world days. Planar time flows consistently across all planes in this campaign — the lone exception is the Time Dragon Renesnuprah — so the Timeline reads as a clean chronicle, not a chronology puzzle.

**Goal 4 — clean, mobile-first presentation.** Players are on phones, so the player default is **wiki tabs**: cover image, a tight sidebar of property blocks (type, ward, proprietor), one scannable Overview. Other tab flavors earn their place only where they beat a wiki:
- **Maps** for dungeon-scale and keyed sites, navigated by pin-and-peek (Section 7).
- **The Conspiracy Board** — the lone Board. The DM curates the red string between Shemeshka, the arms network, Primus, and the Convergence from what the party says; players view always and rearrange when at a real screen.
- **The Timeline**, as above.

---

## 7. Location presentation split

- **Monolithic / building-scale** (Bank of Abbathor, Smoldering Corpse Bar, Anze's Anvil Smithy) → a **single wiki article**. Progressive reveal via secret blocks. No nested room elements.
- **Dungeon-scale / keyed** (Mortuary basement, Derinkuyu) → a location element with a **Map tab**. Rooms are **nested secret elements**, navigated by **pin-and-peek** (the peek window shows revealed tabs in the sidebar), revealed on entry. Players never browse the room list; they tap pins.

---

## 8. Items and consolidation by tag

**Magic Items** holds item elements as they're crafted. The live workflow is per-item: on acquisition and identification, **reveal-and-tag**, and the item drops into the players' "Things we carry" index. Gregory's promissory note is revealed from session one. Items may later be **re-homed** under whatever offers them — a faction reward under that faction, a shop's stock nested in the shop — because the tag index still gathers them into one view regardless of where they live. This is home-vs-hook in practice: the tag is the consolidator, the tree position is just convenience.

---

## 9. Conventions

- **Don't duplicate — link.** An NPC's backstory lives in their article, not repeated in every scene.
- **Cross-references:** write article names without brackets (LegendKeeper auto-detects them). \`[Brackets]\` are acceptable inside secret blocks and hidden tabs. Deep links use \`[Article Name#Tab Name]\`.
- **Footer:** every article ends with a parent link (\`Back to [Parent]\`) for navigation.
- **Read-aloud text** is blockquoted, written for vocal delivery: short sentences, sensory, present tense.
- **The Cold Answer Test** for any location: who's here now, what it looks/smells/sounds like, who runs it, what's for sale, who's tied to a live quest, what rumors circulate, what happens in a fight — all answerable in ten seconds.
- **Party articles** carry the dual-audience risk too: shared backstory in the open, DM hooks (Dan's pending Fated affiliation, any quiet thread into the Convergence) in secret blocks.

---

## 10. Build order — consolidationist

Don't build the world. Build the scaffolding, then fill only what the party will touch.

1. Stand up the root hierarchy and the shells: Campaign Timeline, Chronicle, Field Notes, DM Dashboard.
2. Author one exemplar of each type to lock the pattern: one monolithic building (Bank of Abbathor), one keyed dungeon (Mortuary), one world-mobile NPC (Shemeshka), one session element.
3. Fill the Act 1 Sigil essentials at full depth (Smoldering Corpse Bar, Shattered Temple, Civic Festhall, Mortuary); supporting locations get light prep; conditional locations (Hall of Records, the Prison) stay stubs until they go live.

*Prep energy concentrates only on what the party will actually encounter. Mandatory locations first, likely locations second.*
`;
