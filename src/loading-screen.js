const $ = (id) => document.getElementById(id);

export const nextPaint = () =>
  new Promise((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(resolve)),
  );

export function showLoading(message) {
  $("loading-message").textContent = message;
  $("loading-retry").hidden = true;
  $("scene-loader").hidden = false;
  $("app").inert = true;
  $("app").setAttribute("aria-busy", "true");
  document.body.classList.add("loading");
}

export function hideLoading() {
  $("scene-loader").hidden = true;
  $("app").inert = false;
  $("app").setAttribute("aria-busy", "false");
  document.body.classList.remove("loading");
}

export function loadingFailed(error) {
  console.error("Unable to prepare the match", error);
  showLoading("Couldn't load the stadium. Check your connection and try again.");
  $("loading-retry").hidden = false;
  $("loading-retry").onclick = () => location.reload();
}
