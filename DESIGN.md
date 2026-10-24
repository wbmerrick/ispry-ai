---
name: iSpry.ai
description: Dark mountain telehealth — acid lime brand on ink, Bricolage display, glass composer
colors:
  ink: "#07080C"
  surface: "#12161F"
  surface-deep: "#0E1219"
  line: "#232938"
  text: "#F4F2EB"
  text-muted: "#A3AABB"
  accent: "#D7FF3F"
  danger: "#FF6B5B"
typography:
  display:
    fontFamily: "Bricolage Grotesque, system-ui, sans-serif"
    fontWeight: 800
    letterSpacing: "-0.045em"
  body:
    fontFamily: "IBM Plex Sans, system-ui, sans-serif"
    fontSize: "16px"
    fontWeight: 400
  mono:
    fontFamily: "IBM Plex Mono, ui-monospace, monospace"
    fontSize: "13px"
    letterSpacing: "0.12em"
rounded:
  pill: "999px"
  composer: "32px"
  panel: "28px"
spacing:
  section: "104px"
  wrap: "32px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "0 22px"
    height: "48px"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text}"
    rounded: "{rounded.pill}"
    padding: "0 22px"
    height: "48px"
  chip:
    backgroundColor: "rgba(7,8,12,.55)"
    textColor: "#E8ECF4"
    rounded: "{rounded.pill}"
    padding: "0 20px"
    height: "46px"
---

# Design System — iSpry.ai

## Product Context

Persuade-mode marketing + intake for physician-led Tennessee telehealth. Brand first on the hero (`iSpry.ai`), action line `Just ask.`, then the Spry composer as the primary CTA. Peak photography is the full-bleed world; acid lime (`#D7FF3F`) is the only accent.

## Foundations

- **Ink dark** (`#07080C`) with translucent surfaces over `/bg-peak.webp`
- **Acid lime** for brand `.ai`, primary buttons, focus glow, membership punch panel
- **Display:** Bricolage Grotesque 800; body IBM Plex Sans; labels IBM Plex Mono uppercase
- **Depth:** soft offset shadows + lime ring on composer focus — not purple glow stacks
- **Motion:** hero entrance stagger; section reveal on scroll; respect `prefers-reduced-motion`

## Components

- Primary pill button (lime on ink); ghost outline for Sign in
- Glass idle composer (blur, lime border) → chat shell once conversation starts
- Starter chips under composer (lime outline pills)
- Membership price panel is solid lime; one-time visit is quiet dark panel
- Account modal and handoff forms share surface/line tokens

## Layout

- Sticky lean header (phone · license · same-day) + Sign in + Join
- First viewport: brand H1 → Just ask. → lede → composer → chips
- Below: How (numbered sequence) → Pricing → Limits → FAQ → Doctor → footer safety

## Do / Don't

**Do:** keep peak + lime identity; brand larger than slogans; one primary action in the hero (Ask Spry).  
**Don't:** purple SaaS gradients; Inter/Roboto defaults; cream+terracotta; card grids in the hero; invent clinical claims or reviews.
