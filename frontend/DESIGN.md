---
name: Neo-Digital Brutalism
colors:
  surface: '#faf9f3'
  surface-dim: '#dbdad4'
  surface-bright: '#faf9f3'
  surface-container-lowest: '#ffffff'
  surface-container-low: '#f5f4ee'
  surface-container: '#efeee8'
  surface-container-high: '#e9e8e2'
  surface-container-highest: '#e3e3dd'
  on-surface: '#1b1c19'
  on-surface-variant: '#4c4546'
  inverse-surface: '#30312d'
  inverse-on-surface: '#f2f1eb'
  outline: '#7e7576'
  outline-variant: '#cfc4c5'
  surface-tint: '#5e5e5e'
  primary: '#000000'
  on-primary: '#ffffff'
  primary-container: '#1b1b1b'
  on-primary-container: '#848484'
  inverse-primary: '#c6c6c6'
  secondary: '#0058be'
  on-secondary: '#ffffff'
  secondary-container: '#2170e4'
  on-secondary-container: '#fefcff'
  tertiary: '#000000'
  on-tertiary: '#ffffff'
  tertiary-container: '#231a00'
  on-tertiary-container: '#a08000'
  error: '#ba1a1a'
  on-error: '#ffffff'
  error-container: '#ffdad6'
  on-error-container: '#93000a'
  primary-fixed: '#e2e2e2'
  primary-fixed-dim: '#c6c6c6'
  on-primary-fixed: '#1b1b1b'
  on-primary-fixed-variant: '#474747'
  secondary-fixed: '#d8e2ff'
  secondary-fixed-dim: '#adc6ff'
  on-secondary-fixed: '#001a42'
  on-secondary-fixed-variant: '#004395'
  tertiary-fixed: '#ffe087'
  tertiary-fixed-dim: '#efc112'
  on-tertiary-fixed: '#231a00'
  on-tertiary-fixed-variant: '#574500'
  background: '#faf9f3'
  on-background: '#1b1c19'
  surface-variant: '#e3e3dd'
typography:
  headline-xl:
    fontFamily: Space Grotesk
    fontSize: 84px
    fontWeight: '700'
    lineHeight: 90px
    letterSpacing: -0.04em
  headline-xl-mobile:
    fontFamily: Space Grotesk
    fontSize: 44px
    fontWeight: '700'
    lineHeight: 48px
    letterSpacing: -0.03em
  headline-lg:
    fontFamily: Space Grotesk
    fontSize: 56px
    fontWeight: '700'
    lineHeight: 60px
    letterSpacing: -0.03em
  headline-lg-mobile:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '700'
    lineHeight: 36px
    letterSpacing: -0.02em
  headline-md:
    fontFamily: Space Grotesk
    fontSize: 32px
    fontWeight: '600'
    lineHeight: 38px
    letterSpacing: -0.02em
  headline-sm:
    fontFamily: Space Grotesk
    fontSize: 24px
    fontWeight: '600'
    lineHeight: 30px
    letterSpacing: -0.01em
  body-lg:
    fontFamily: Space Grotesk
    fontSize: 18px
    fontWeight: '400'
    lineHeight: 26px
    letterSpacing: -0.01em
  body-md:
    fontFamily: Space Grotesk
    fontSize: 16px
    fontWeight: '400'
    lineHeight: 24px
    letterSpacing: 0em
  body-sm:
    fontFamily: Space Grotesk
    fontSize: 14px
    fontWeight: '400'
    lineHeight: 20px
    letterSpacing: 0em
  label-code:
    fontFamily: Space Mono
    fontSize: 13px
    fontWeight: '700'
    lineHeight: 16px
    letterSpacing: 0.02em
  label-nav:
    fontFamily: Space Grotesk
    fontSize: 15px
    fontWeight: '600'
    lineHeight: 18px
    letterSpacing: -0.01em
spacing:
  gutter: 0px
  gutter-desktop: 0px
  margin: 0px
  space-xs: 0.25rem
  space-sm: 0.5rem
  space-md: 1rem
  space-lg: 1.5rem
  space-xl: 2.5rem
---

## Brand & Style

The design system embodies a neo-brutalist, retro-digital aesthetic engineered for high-energy developer ecosystems, hackathons, and web3 infrastructure. It merges the tactile nostalgia of isometric physical keycaps and mechanical components with the systematic precision of graph paper and terminal code syntax.

The emotional tone is technical, unapologetically bold, playful, and developer-first. The visual architecture relies on crisp structural gridlines, razor-sharp rectangular containers, and bold dividing lines paired with vibrant pop-color blocks (canary yellow, electric mint, lavender, and vibrant blue) contrasted against warm light backgrounds.

## Colors

The palette is anchored by stark `#000000` structure and high-saturation functional accents over a warm parchment neutral:

- **Base Canvas:** `#F5F4EE` warm off-white / light cream.
- **Structural Black:** `#000000` applied to all primary typography, segmented borders, rules, and solid dark button states.
- **Cyan Grid:** `#4DA2FF` used at low opacity (15% to 30%) or thin 1px lines across white cards and section hero backdrops to evoke blueprint graph paper.
- **Accent - Electric Blue:** `#3B82F6` (and `#4DA2FF`) used for active docked tab states, utility action triggers, and directional icon badges.
- **Accent - Sunflower Yellow:** `#FFD028` used for code tags, highlights, and primary track cards.
- **Accent - Mint Green:** `#00D287` (and `#22C55E`) for financial primitives, success indicators, and secondary category badges.
- **Accent - Lilac / Lavender:** `#E4D4F8` for tertiary highlight modules, prize rank bands, and full-width promo stripes.
- **Accent - International Orange:** `#FF6B00` used for energetic states, track markers, and warm isometric elements.

## Typography

The type scale combines dense, tightly tracked geometric grotesque display titles with precise monospaced code syntax:

- **Headlines & Body:** Space Grotesk provides an engineered, structural presence. Display headlines (`headline-xl`, `headline-lg`) must use aggressive negative letter spacing (`-0.03em` to `-0.04em`) to create dense, impactful headline blocks.
- **Developer Meta & Code Tags:** Space Mono provides explicit syntax conventions. Used exclusively for XML-like bracket metadata (e.g. `<date>`, `</date>`), rank tokens (`[# 1st place]`), and track markers.

## Layout & Spacing

The layout is built on an architectural, tabular grid paradigm with collapsed gutters (`0px`) where adjacent cards and navigation segments share a unified single 1px or 2px black dividing rule:

- **Docked Modular Grid:** Modules snap edge-to-edge. Rather than floating cards with soft outer margins, primary layouts assemble like a printer sheet or drafting board divided by stark black gridlines.
- **Graph Blueprint Backdrops:** Major hero banners and card top headers feature a repeating 24px x 24px or 32px x 32px grid pattern rendered in `#4DA2FF` at 25% opacity over pure white `#FFFFFF`.
- **Bottom Navigation Dock:** Fixed bottom dock running 100% viewport width, segmented into equal tabular buttons separated by vertical 1px/2px black borders.

## Elevation & Depth

Visual hierarchy is achieved through pure flat neo-brutalism and physical isometric layering rather than blurred ambient drop shadows:

- **Flat Border Enclosures:** 1px to 2px solid `#000000` boundaries dictate all elevation tiers. No blurred elevation is used on standard containers.
- **Tactile Hard Shadows (Optional):** When interactive cards or popovers require depth, use solid, unblurred hard black drop shadows: `box-shadow: 4px 4px 0px #000000;`.
- **Isometric Visual Assets:** 3D rendered keycaps, metallic tokens, and isometric blocks contrast against the razor-sharp 2D wireframe structure.

## Shapes

The shape system strictly uses 0px roundedness (`roundedness: 0`). 

All buttons, docked navigation items, prize tables, track cards, code tags, and input surfaces are sharp rectangles. The only curved elements are contextual brand illustrations, circular coin graphics, and mechanical keycap artwork sitting inside these strict geometric rectangular bounds.

## Components

### Buttons & Compound Action Triggers
- **Segmented Action Button:** A two-part container wrapped in a 1px solid black border. The left part contains high-contrast text (`#000000` background with white text, or `#FFFFFF` with black text); the right part is a square tile filled with `#3B82F6` containing a diagonal arrow icon (`↗`).
- **Interactive State:** On hover, inverted color states or a 2px offset translate (`translate(-2px, -2px)` with a matching `2px 2px 0px #000000` shadow).

### Docked Segmented Navigation
- **Architecture:** Fixed or static horizontal bar spanning the viewport width, encased by a top black border (`1px` or `2px`).
- **Items:** Border-right divider between each item (`1px solid #000000`). Each segment displays a centered `label-nav` title.
- **Active State:** Solid fill with `#3B82F6`, `#FF6B00`, `#E4D4F8`, or `#FFD028` with `#000000` text.
- **Lead Segment:** Leftmost item features an icon-only or badge-plus-text indicator.

### Track & Content Cards
- **Structure:** Crisp rectangular enclosure with `border: 1px solid #000000` or `border: 2px solid #000000`.
- **Header Section:** Features a graph-paper background pattern (`#FFFFFF` background with `#4DA2FF` fine grid lines), housing an inline icon badge and title.
- **Media / Illustration Banner:** Solid saturated block (e.g., `#FFD028` or `#00D287`) showcasing centered isometric graphic assets.
- **Content Footprint:** White or cream base containing body descriptions in `Space Grotesk`.

### Code Tags & Rank Badges
- **Syntax Tags:** Small rectangular badges with `border: 1px solid #000000`, filled with `#FFD028` or `#00D287`, rendering monospaced text like `Core Track` or `<date>`.
- **Prize Badges:** Compound pill/box tags like `# 1st place }` with alternating background fills (green `#00D287` for `#` and yellow `#FFD028` for the place rank).

### Accordion / FAQ List
- **Row Styling:** Edge-to-edge stacked rows separated by `border-bottom: 1px solid #000000`.
- **Typography:** `headline-sm` or `headline-md` weight.
- **Action Control:** Right-aligned square box delineated by a vertical black line, containing a 6-dot matrix icon or plus toggle.
