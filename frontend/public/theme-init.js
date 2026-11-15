// Run before styles and React so a saved dark preference never paints a light page first.
(() => {
  let preference = "system";
  try {
    const saved = localStorage.getItem("mas-theme");
    if (saved === "light" || saved === "dark") {
      preference = saved;
    }
  } catch {
    // Private browsing can disable storage; system preference still works.
  }

  const dark =
    preference === "dark" ||
    (preference === "system" && matchMedia("(prefers-color-scheme: dark)").matches);

  document.documentElement.dataset.themePreference = preference;
  document.documentElement.dataset.theme = dark ? "dark" : "light";
  document.documentElement.style.colorScheme = dark ? "dark" : "light";
})();
