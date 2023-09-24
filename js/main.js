import makeConfig from "./config.js";

const canvas = document.createElement("canvas");
var contentElement = document.getElementById("content");
contentElement.appendChild(canvas);
document.addEventListener("touchmove", (e) => e.preventDefault(), {
  passive: false,
});

const supportsWebGPU = async () => {
  return (
    window.GPUQueue != null &&
    navigator.gpu != null &&
    navigator.gpu.getPreferredCanvasFormat != null
  );
};

const isRunningSwiftShader = () => {
  const gl = document.createElement("canvas").getContext("webgl");
  const debugInfo = gl.getExtension("WEBGL_debug_renderer_info");
  const renderer = gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL);
  return renderer.toLowerCase().includes("swiftshader");
};

document.body.onload = async () => {
  const urlParams = new URLSearchParams(window.location.search);
  const config = makeConfig(Object.fromEntries(urlParams.entries()));
  const useWebGPU =
    (await supportsWebGPU()) &&
    ["webgpu"].includes(config.renderer?.toLowerCase());
  const solution = import(`./${useWebGPU ? "webgpu" : "regl"}/main.js`);

  if (true) {
    const urlParams = new URLSearchParams(window.location.search);
    const myParam = urlParams.get("name");
    const notice = document.createElement("notice");
    notice.innerHTML = `<div class="notice">
    <p>${myParam}<p>
    <button class="blue pill">Xem ik nè!</button>
		`;
    canvas.style.display = "none";
    document.body.appendChild(notice);
    document.querySelector(".blue.pill").addEventListener("click", async () => {
      config.suppressWarning = true;
      // urlParams.set("name", myParam);
      // urlParams.set("suppressWarnings", true);
      history.replaceState({}, "", "?" + urlParams.toString());
      (await solution).default(canvas, config);
      canvas.style.display = "unset";
      document.body.removeChild(notice);
    });
  } else {
    (await solution).default(canvas, config);
  }
};
