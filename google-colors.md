Yes. Google Cloud Console (Pantheon) and the broader Google ecosystem rely on the **Google Material 2 (GM2) Grayscale Palette** for layout, borders, dividers, and typography. 

Additionally, Pantheon has a custom monochrome shading palette specifically used for dashboard icons and graphical accents.

---

### 1. Standard Google Material 2 (GM2) Greyscale
This is the standard monochrome palette used for structural elements and typography in Google dashboards:

| Name | HEX Code | Common Pantheon Usage |
| :--- | :--- | :--- |
| **Grey 900** | `#202124` | Primary text, Headings, Titles |
| **Grey 800** | `#3C4043` | Subheadings, high-emphasis icons |
| **Grey 700** | `#5F6368` | Secondary text, Body text, Standard icons |
| **Grey 600** | `#80868B` | Disabled text, Placeholders, Neutral status |
| **Grey 500** | `#9AA0A6` | Subtle accents, Secondary icons |
| **Grey 400** | `#BDC1C6` | Very subtle accents |
| **Grey 300** | `#DADCE0` | **Standard Dividers, Borders, Outlines** |
| **Grey 200** | `#E8EAED` | Secondary Borders, Hover states |
| **Grey 100** | `#F1F3F4` | Alternate row colors, Subtle chip backgrounds |
| **Grey 50** | `#F8F9FA` | **Page backgrounds, Panel backdrops** |

---

### 2. Pantheon Monotone Icon Shading Palette
If you are duplicating Google Cloud's product logos/monotone dashboard icons, Pantheon uses a specific 3-tier grayscale palette derived from opacity guidelines:

| Shading Level | HEX Code | Opacity Equivalency |
| :--- | :--- | :--- |
| **Solid** | `#424242` | 100% |
| **Medium** | `#616161` | 80% |
| **Light** | `#757575` | 60% |



---

### 3. The Gemini Color Palette & Gradient
The Gemini identity breaks away from Google's traditional 4-color palette (Blue, Red, Yellow, Green) and embraces a dynamic, futuristic **Aurora Gradient** (Blue, Purple, and Pink/Coral). This palette is used throughout the Gemini app, Cloud Console AI integrations, and dashboard banners to indicate "AI-powered" or "Smart" features.

#### Signature Color Stops
Though hex codes can vary slightly between text gradients, glowing borders, and icons, the core standard spectrum moves through these tones:
*   **Bright Blue / Cyan:** `#217BFE` / `#078EFB`
*   **Amethyst Purple:** `#A770EF` / `#9D50BB`
*   **Coral Pink:** `#FF5E62` / `#E46962`

####  Implementing Gemini Style Externally
If you are building an external application and want to simulate the "Gemini glow" or AI aesthetic, you can use these Tailwind or native CSS recipes:

```css
/* 1. Signature Gemini Text Gradient */
.gemini-gradient-text {
  background: linear-gradient(90deg, #217BFE 0%, #078EFB 33%, #A770EF 66%, #FF5E62 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  display: inline-block;
  font-weight: bold;
}

/* 2. Soft Glowing AI Card */
.gemini-glow-card {
  background: #ffffff;
  border-radius: 8px;
  box-shadow: 0 0 20px rgba(33, 123, 254, 0.15), 
              0 0 40px rgba(167, 112, 239, 0.1);
  border: 1px solid rgba(167, 112, 239, 0.2);
}
```

---

### 4. Antigravity Colors & Aesthetic
**Antigravity** is not a public-facing color standard; it is a Google development platform (including **Antigravity IDE** and **Antigravity CLI**) centered on agentic, autonomous coding and design workflows. 

However, in its tooling and related workshops, it champions a very specific developer aesthetic:

*   **Core Aesthetic:** Sleek Dark Mode with Glassmorphism.
*   **Palette Choices:**
    *   **Backgrounds:** Deep space / midnight blues (`#0B0F19` or similar).
    *   **Cards/Panels:** Semi-transparent frosted-glass containers.
    *   **Accents:** Glowing neon blue/purple gradients (to reference AI assistance) or vibrant emerald green (for success states).
*   **Command Line (TUI):** High-contrast color schemes tailored for code readability, utilizing standard terminal colors but leaning heavily into vibrant Cyan/Magenta accents.

---

### 💡 Recommendation for External Web UIs
*   If you are creating an **AI Feature Module**, use the **Gemini Blue-to-Pink Gradient** to indicate intelligence and signal Google's modern AI branding.
*   If you are building a **Developer Tool or Dashboard**, consider the **Antigravity Dark/Glassmorphic** approach, making heavy use of deep midnight backgrounds, translucent overlays, and neon accent colors for graphs and indicators.



To build a web UI outside of `google3` that mirrors the Google Cloud Console (Pantheon) style, you will need to manually implement the palette, as the internal Design Token system (`cm.sys.color.*`) is not publicly exposed. 

Pantheon’s UI is heavily derived from **Google Material 2 (GM2)** but has specific tweaks for accessibility, readability, and contrast within a dashboard environment.

Here are the standard hex codes used in Pantheon for the UI, along with guidance on how to organize them.

---

### 1. The Pantheon UI Color Palette (Light Mode)

#### 🔵 Primary & Action Colors
* **Primary / Focus (Google Blue 600):** `#1A73E8`
* **Active State (Google Blue 700):** `#1967D2`
* **Focus Tint / Light Background:** `#E8F0FE`

#### 🚦 Status & Feedback Colors
Pantheon uses highly specific, accessible status colors:
* **Success (Green):** `#188038`
* **Error (Red):** `#D50000`
* **Warning (Deep Orange/Yellow):** `#DC6D00`
* **Neutral / Info:** `#80868B`

#### ⚪ Backgrounds & Dividers
* **Page Background:** `#F8F9FA` (Or pure white `#FFFFFF`)
* **Panel / Container Background:** `#FFFFFF`
* **Dividers / Borders:** `#DADCE0` (Secondary Borders: `#E8EAED`)

#### ⚫ Typography (Text Colors)
* **Primary Text (Headings/Titles):** `#202124` (Grey 900)
* **Secondary Text (Captions/Body):** `#5F6368` (Grey 700)
* **Disabled Text:** `#80868B` (Grey 600)

---

### 2. Pantheon Product Icon Shading Palette
If you are designing custom icons or graphical accents that match Google Cloud's product dashboards, Pantheon uses this distinct 3-tone monotone opacity shading:

| Tone / Opacity | Shaded Blues | Shaded Greys |
| :--- | :--- | :--- |
| **Light (60%)** | `#85A4E6` | `#757575` |
| **Medium (80%)** | `#5C85DE` | `#616161` |
| **Solid (100%)** | `#3367D6` | `#424242` |

---

### 💡 Best Practices for External Implementation

Since you do not have the internal token system, **do not hardcode hex values** throughout your components. Setup standard variables.

#### Option A: CSS Variables (Native Custom Properties)
Define your semantic scheme in your root stylesheet. This sets you up to easily support a dark mode context later.

```css
:root {
  /* Core Actions */
  --cm-sys-color-primary: #1A73E8;
  --cm-sys-color-on-primary: #FFFFFF;

  /* Status */
  --cm-sys-color-success: #188038;
  --cm-sys-color-warning: #DC6D00;
  --cm-sys-color-error: #D50000;

  /* Typography */
  --cm-sys-color-text-primary: #202124;
  --cm-sys-color-text-secondary: #5F6368;

  /* Borders & Backgrounds */
  --cm-sys-color-border: #DADCE0;
  --cm-sys-color-bg-base: #F8F9FA;
  --cm-sys-color-bg-surface: #FFFFFF;
}
```

#### Option B: Tailwind CSS Configuration
If using Tailwind, add these to your `tailwind.config.js` to ensure the core Cloud UI palette is easily accessible through classes like `bg-cloud-primary` or `text-cloud-success`.

```javascript
// tailwind.config.js
module.exports = {
  theme: {
    extend: {
      colors: {
        'cloud-primary': '#1A73E8',
        'cloud-success': '#188038',
        'cloud-error': '#D50000',
        'cloud-warning': '#DC6D00',
        'cloud-text-primary': '#202124',
        'cloud-text-secondary': '#5F6368',
        'cloud-border': '#DADCE0',
        'cloud-bg': '#F8F9FA',
      }
    }
  }
}
```

---

When implementing the **Dark Mode** equivalent of Pantheon (Google Cloud Console) externally, you swap the high-saturation colors and bright backgrounds for a **de-saturated, high-contrast palette** derived from Google Material 2 (GM2) Dark Mode guidelines.

As with standard mode, components indicate hierarchy using elevation and desaturated tones to maintain accessibility. 

---

### 1. Pantheon Dark Mode UI Palette

#### 🔵 Primary & Action Colors (Dark)
In dark mode, high-saturation blues become too harsh or yield poor contrast.
* **Primary / Actions (Google Blue 300):** `#8AB4F8`
* **On Primary (Text on Action):** `#202124` (Grey 900)
* **Secondary / Muted Background Action:** `#394557` (A desaturated translucent blue blending over dark backgrounds)

#### 🚦 Status & Feedback Colors (Dark)
Status colors use lighter (300-level) shades to maintain legibility on dark surfaces.
* **Success (Green 300):** `#81C995`
* **Error (Red 300):** `#F28B82`
* **Warning (Yellow 300):** `#FDD663`
* **Neutral / Info (Grey 400):** `#BDC1C6`

---

### 2. Dark Mode Backgrounds & Elevations
Unlike light mode which uses shadows for depth, **Pantheon Dark Mode uses lighter shades of grey** to express elevation and hierarchy.

| Elevation Level | HEX Code | Equivalent Internal Concept |
| :--- | :--- | :--- |
| **Lowest (Deepest Backing)** | `#121212` | True system background |
| **Level 0 (Page Base)** | `#202124` | Grey 900 (Canvas / Main Dashboard) |
| **Level 1 (Panels / Cards)** | `#2A2B2E` | Subtle elevation blend |
| **Level 2 (Modals / Flyouts)** | `#303134` | Stronger elevation blend |
| **Level 3 (Hovels / Popovers)**| `#3C4043` | Grey 800 (Lightest container) |

---

### 3. Dark Mode Typography & Dividers
* **Primary Text (Headings/Titles):** `#E8EAED` (Grey 200)
* **Secondary Text (Body/Captions):** `#9AA0A6` (Grey 500)
* **Disabled Text:** `#80868B` (Grey 600)
* **Dividers / Borders:** `#3C4043` (Grey 800)

---

### 💡 External Implementation Recipe (CSS Variables)

Here is how you can configure your external application to toggle between Pantheon Light and Dark modes seamlessly using CSS Variables bound to a `data-theme` attribute on the HTML document body.

```css
/* ☀️ LIGHT MODE (Default) */
:root {
  --cm-sys-color-bg-base: #F8F9FA;
  --cm-sys-color-bg-surface: #FFFFFF;
  --cm-sys-color-border: #DADCE0;
  
  --cm-sys-color-text-primary: #202124;
  --cm-sys-color-text-secondary: #5F6368;
  
  --cm-sys-color-primary: #1A73E8;
  --cm-sys-color-success: #188038;
  --cm-sys-color-error: #D50000;
  --cm-sys-color-warning: #DC6D00;
}

/* 🌙 DARK MODE */
[data-theme='dark'] {
  --cm-sys-color-bg-base: #121212;
  --cm-sys-color-bg-surface: #202124; /* Grey 900 */
  --cm-sys-color-border: #3C4043;     /* Grey 800 */
  
  --cm-sys-color-text-primary: #E8EAED; /* Grey 200 */
  --cm-sys-color-text-secondary: #9AA0A6; /* Grey 500 */
  
  --cm-sys-color-primary: #8AB4F8; /* Blue 300 */
  --cm-sys-color-success: #81C995; /* Green 300 */
  --cm-sys-color-error: #F28B82;   /* Red 300 */
  --cm-sys-color-warning: #FDD663; /* Yellow 300 */
}
```

---


The Google Cloud color palette differs slightly depending on whether you are working on **Brand/Marketing** materials or developing for the **Google Cloud Console (Pantheon) UI**. 

---

### 1. Google Cloud Brand & Marketing Palette
Google Cloud branding builds from white and uses core colors as accents to maintain a clear, uncluttered look.

#### Core Brand Colors
* **Google Blue 500**: HEX `#3186FF` | RGB `(49, 134, 255)`
* **Google Red 500**: HEX `#FC413D` | RGB `(252, 65, 61)`
* **Google Yellow 500**: HEX `#FEC700` | RGB `(254, 199, 0)`
* **Google Green 500**: HEX `#00AF57` | RGB `(0, 175, 87)`

#### Background Colors
* **White**: HEX `#FFFFFF` (Preferred background)
* **Google Grey 10**: HEX `#F8F9FC` (For digital banners/marketing backgrounds only)
* **Google Grey 1000**: HEX `#212226` (Used selectively for emphasis; avoid pure black backgrounds)

---

### 2. Pantheon (Cloud Console) UI Colors
If you are engineering frontend features for Pantheon, **do not use hardcoded HEX values**. Instead, use **Design Tokens**. Tokens automatically adapt your UI for accessibility and context switching (such as Light and Dark modes).

#### System Tokens Usage Example (SCSS)
Always choose a token by its semantic meaning rather than its underlying color value.

```scss
@use 'cloud/console/web/common/cloud_matter/themes/cm/tokens';

.MyDataContainer {
  // Good: Uses semantic system tokens
  background-color: tokens.get('cm.sys.color.container');
  color: tokens.get('cm.sys.color.on-container');
}

.MyBadContainer {
  // Bad: Avoid hardcoded hex values or direct reference palette tokens
  background-color: #1a73e8; 
  color: tokens.get('cm.ref.gm2-palette.blue600'); 
}
```

#### Pantheon Product Icons Palette
Monotone product icons in the Cloud Console use a 3-shade gradient of either Blues or Greys:

| Opacity | Shaded Blues (Pantheon) | Shaded Greys (Pantheon) |
| :--- | :--- | :--- |
| **60%** | `#85A4E6` | `#757575` |
| **80%** | `#5C85DE` | `#616161` |
| **100%** | `#3367D6` | `#424242` |

---

### Best Practices Summary
* **Build from white**: Use negative space and keep designs clear. Take out unnecessary visual elements.
* **Use tokens for UI**: Pantheon developers should rely on `cm.sys.color.*` tokens to ensure seamless transitions between themes (like Dark Mode).
* **Respect Clear Space**: Maintain designated padding around core brand elements like the "Super Cloud" icon.
