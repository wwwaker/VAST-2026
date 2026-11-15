/** Optional before/after evidence for the real-browser readability scenarios. */
import fs from "node:fs";
import path from "node:path";

/** Replay saved pre-refactor CSS on the same investigation state to remove scroll races. */
export async function replayLightTheme(page) {
  if (!process.env.MAS_LIGHT_THEME_SOURCE) {
    return null;
  }

  const source = process.env.MAS_LIGHT_THEME_SOURCE;
  const read = (file) => fs.readFileSync(path.join(source, file), "utf8");
  const optional = (file) => (fs.existsSync(path.join(source, file)) ? read(file) : "");
  const palette = optional("shared/styles/theme-tokens.css");

  const shared =
    read("shared/styles/workspace-base.css") +
    optional("shared/styles/workspace-layout.css") +
    read("shared/styles/workspace-theme.css") +
    read("shared/styles/window-range.css");

  const controls = read("shared/styles/workspace-controls.css");

  return page.evaluate(
    ({ documentCss, workspaces, legacyBackground }) => {
      const host = [...document.querySelectorAll("[data-testid]")].find(
        (element) => element.shadowRoot,
      );

      const style = host.shadowRoot.querySelector("style");
      const previous = { workspace: style.textContent, background: host.style.background };
      const documentStyle = document.createElement("style");
      documentStyle.dataset.lightThemeOriginal = "";
      documentStyle.textContent = documentCss;
      document.head.append(documentStyle);
      if (legacyBackground) {
        host.style.background = "#f5f7fa";
      }
      style.textContent = workspaces[host.dataset.testid];

      return previous;
    },
    {
      documentCss: palette + read("shared/styles/document.css"),
      legacyBackground: !palette,
      workspaces: {
        "mc1-reference": shared,
        "mc2-reference":
          shared +
          controls +
          read("features/mc2/styles/page.css") +
          read("features/mc2/styles/workspace.css"),
        "custom-reference": shared + controls + read("features/custom/styles.css"),
      },
    },
  );
}

export async function restoreLightTheme(page, previous) {
  await page.evaluate((previous) => {
    const host = [...document.querySelectorAll("[data-testid]")].find(
      (element) => element.shadowRoot,
    );

    host.shadowRoot.querySelector("style").textContent = previous.workspace;
    host.style.background = previous.background;
    document.querySelector("[data-light-theme-original]").remove();
  }, previous);
}

export async function lightThemeSnapshot(page, imagePath) {
  if (!process.env.MAS_LIGHT_THEME_SNAPSHOT) {
    return;
  }

  if (!/nav-(hover|focus)-/.test(imagePath)) {
    await page.mouse.move(0, 0);
  }

  await page.evaluate(async () => {
    await document.fonts.ready;
    // Caret blinking is independent of CSS changes. Keep ordinary focus styling visible.
    for (const root of [
      document,
      ...[...document.querySelectorAll("*")].map((element) => element.shadowRoot).filter(Boolean),
    ]) {
      if (!root.querySelector("[data-light-theme-caret]")) {
        const style = document.createElement("style");
        style.dataset.lightThemeCaret = "";
        style.textContent = "* { caret-color: transparent !important; }";
        (root.head ?? root).append(style);
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  const snapshot = await page.evaluate(() => {
    const properties = [
      "color",
      "background-color",
      "background-image",
      "box-shadow",
      "text-shadow",
      "border-top-color",
      "border-right-color",
      "border-bottom-color",
      "border-left-color",
      "border-top-width",
      "border-right-width",
      "border-bottom-width",
      "border-left-width",
      "border-top-style",
      "border-right-style",
      "border-bottom-style",
      "border-left-style",
      "border-top-left-radius",
      "border-top-right-radius",
      "border-bottom-left-radius",
      "border-bottom-right-radius",
      "outline-color",
      "outline-width",
      "outline-style",
      "outline-offset",
      "fill",
      "stroke",
      "stroke-width",
      "fill-opacity",
      "stroke-opacity",
      "opacity",
      "accent-color",
      "color-scheme",
      "font-family",
      "font-size",
      "font-weight",
      "line-height",
      "letter-spacing",
      "display",
      "position",
      "padding-top",
      "padding-right",
      "padding-bottom",
      "padding-left",
      "margin-top",
      "margin-right",
      "margin-bottom",
      "margin-left",
      "gap",
      "grid-template-columns",
      "overflow-x",
      "overflow-y",
    ];

    const nodes = [];

    const visit = (element, key) => {
      if (!element.matches("script, style, link, meta")) {
        const style = getComputedStyle(element);
        const rect = element.getBoundingClientRect();
        if (rect.width || rect.height || element === document.documentElement) {
          nodes.push({
            key,
            tag: element.tagName,
            className: element.getAttribute("class"),
            state: ["hover", "focus", "focus-visible", "disabled", "checked"].filter((state) =>
              element.matches(`:${state}`),
            ),
            styles: Object.fromEntries(
              properties.map((prop) => [prop, style.getPropertyValue(prop)]),
            ),
            size: [rect.width, rect.height].map((value) => Math.round(value * 100) / 100),
          });
        }
      }
      [...element.children].forEach((child, index) => visit(child, `${key}/${index}`));
      if (element.shadowRoot) {
        [...element.shadowRoot.children].forEach((child, index) =>
          visit(child, `${key}/shadow/${index}`),
        );
      }
    };

    visit(document.documentElement, "html");

    return { viewport: [innerWidth, innerHeight], nodes };
  });

  fs.writeFileSync(imagePath.replace(/\.png$/, ".styles.json"), JSON.stringify(snapshot));
}
