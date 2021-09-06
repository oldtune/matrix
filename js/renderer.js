import {
  extractEntries,
  loadImage,
  makePassFBO,
  makeDoubleBuffer,
  makePass
} from "./utils.js";

const rippleTypes = {
  box: 0,
  circle: 1
};

const cycleStyles = {
  cycleFasterWhenDimmed: 0,
  cycleRandomly: 1
};

const numVerticesPerGlyph = 2 * 3;

const camera = glMatrix.mat4.create();
const transform = glMatrix.mat4.create();

export default (regl, config) => {
  // These two framebuffers are used to compute the raining code.
  // they take turns being the source and destination of the "compute" shader.
  // The half float data type is crucial! It lets us store almost any real number,
  // whereas the default type limits us to integers between 0 and 255.

  // This double buffer is smaller than the screen, because its pixels correspond
  // with glyphs in the final image, and the glyphs are much larger than a pixel.
  const doubleBuffer = makeDoubleBuffer(regl, {
    radius: config.numColumns,
    wrapT: "clamp",
    type: "half float"
  });

  const numColumns = config.numColumns;

  const output = makePassFBO(regl, config.useHalfFloat);

  const uniforms = extractEntries(config, [
    // rain general
    "glyphHeightToWidth",
    "glyphTextureColumns",
    "numColumns",
    // rain update
    "animationSpeed",
    "brightnessMinimum",
    "brightnessMix",
    "brightnessMultiplier",
    "brightnessOffset",
    "cursorEffectThreshold",
    "cycleSpeed",
    "fallSpeed",
    "glyphSequenceLength",
    "hasSun",
    "hasThunder",
    "raindropLength",
    "rippleScale",
    "rippleSpeed",
    "rippleThickness",
    // rain render
    "glyphEdgeCrop",
    "isPolar"
  ]);

  uniforms.rippleType =
    config.rippleTypeName in rippleTypes
      ? rippleTypes[config.rippleTypeName]
      : -1;
  uniforms.cycleStyle =
    config.cycleStyleName in cycleStyles
      ? cycleStyles[config.cycleStyleName]
      : 0;
  uniforms.slantVec = [Math.cos(config.slant), Math.sin(config.slant)];
  uniforms.slantScale =
    1 / (Math.abs(Math.sin(2 * config.slant)) * (Math.sqrt(2) - 1) + 1);
  uniforms.showComputationTexture = config.effect === "none";

  const msdfLoader = loadImage(regl, config.glyphTexURL);

  // This shader is the star of the show.
  // In normal operation, each pixel represents a glyph's:
  //   R: brightness
  //   G: progress through the glyph sequence
  //   B: current glyph index
  //   A: additional brightness, for effects
  const update = regl({
    frag: `
      precision highp float;

      #define PI 3.14159265359
      #define SQRT_2 1.4142135623730951
      #define SQRT_5 2.23606797749979

      uniform float time;
      uniform float numColumns;
      uniform sampler2D lastState;
      uniform bool hasSun;
      uniform bool hasThunder;
      uniform bool showComputationTexture;
      uniform float brightnessMinimum, brightnessMultiplier, brightnessOffset, brightnessMix;
      uniform float animationSpeed, fallSpeed, cycleSpeed;
      uniform float raindropLength;
      uniform float glyphHeightToWidth;
      uniform int cycleStyle;
      uniform float rippleScale, rippleSpeed, rippleThickness;
      uniform int rippleType;
      uniform float cursorEffectThreshold;

      float max2(vec2 v) {
        return max(v.x, v.y);
      }

      highp float rand( const in vec2 uv ) {
        const highp float a = 12.9898, b = 78.233, c = 43758.5453;
        highp float dt = dot( uv.xy, vec2( a,b ) ), sn = mod( dt, PI );
        return fract(sin(sn) * c);
      }

      vec2 rand2(vec2 p) {
        return fract(vec2(sin(p.x * 591.32 + p.y * 154.077), cos(p.x * 391.32 + p.y * 49.077)));
      }

      float getRainTime(float simTime, vec2 glyphPos) {
        float columnTimeOffset = rand(vec2(glyphPos.x, 0.0));
        float columnSpeedOffset = rand(vec2(glyphPos.x + 0.1, 0.0));
        float columnTime = (columnTimeOffset * 1000.0 + simTime * 0.5 * fallSpeed) * (0.5 + columnSpeedOffset * 0.5) + (sin(simTime * fallSpeed * columnSpeedOffset) * 0.2);
        return (glyphPos.y * 0.01 + columnTime) / raindropLength;
      }

      float getRainBrightness(float rainTime) {
        float value = 1.0 - fract((rainTime + 0.3 * sin(SQRT_2 * rainTime) + 0.2 * sin(SQRT_5 * rainTime)));
        return log(value * 1.25) * 3.0;
      }

      float getGlyphCycleSpeed(float rainTime, float brightness) {
        float glyphCycleSpeed = 0.0;
        if (cycleStyle == 0 && brightness > 0.0) {
          glyphCycleSpeed = pow(1.0 - brightness, 4.0);
        } else if (cycleStyle == 1) {
          glyphCycleSpeed = fract((rainTime + 0.7 * sin(SQRT_2 * rainTime) + 1.1 * sin(SQRT_5 * rainTime))) * 0.75;
        }
        return glyphCycleSpeed;
      }

      float applySunShower(float rainBrightness, vec2 screenPos) {
        if (rainBrightness < -4.) {
          return rainBrightness;
        }
        float value = pow(fract(rainBrightness * 0.5), 3.0) * screenPos.y * 1.5;
        return value;
      }

      float applyThunder(float rainBrightness, float simTime, vec2 screenPos) {
        simTime *= 0.5;
        float thunder = 1.0 - fract((simTime + 0.3 * sin(SQRT_2 * simTime) + 0.2 * sin(SQRT_5 * simTime)));
        thunder = log(thunder * 1.5) * 4.0;
        thunder = clamp(thunder, 0., 1.);
        thunder = thunder * pow(screenPos.y, 2.) * 3.;
        return rainBrightness + thunder;
      }

      float applyRippleEffect(float effect, float simTime, vec2 screenPos) {
        if (rippleType == -1) {
          return effect;
        }

        float rippleTime = (simTime * 0.5 + 0.2 * sin(simTime)) * rippleSpeed + 1.;

        vec2 offset = rand2(vec2(floor(rippleTime), 0.)) - 0.5;
        vec2 ripplePos = screenPos * 2.0 - 1.0 + offset;
        float rippleDistance;
        if (rippleType == 0) {
          rippleDistance = max2(abs(ripplePos) * vec2(1.0, glyphHeightToWidth));
        } else if (rippleType == 1) {
          rippleDistance = length(ripplePos);
        }

        float rippleValue = fract(rippleTime) * rippleScale - rippleDistance;

        if (rippleValue > 0. && rippleValue < rippleThickness) {
          return effect + 0.75;
        } else {
          return effect;
        }
      }

      float applyCursorEffect(float effect, float brightness) {
        if (brightness >= cursorEffectThreshold) {
          effect = 1.0;
        }
        return effect;
      }

      void main()  {

        vec2 glyphPos = gl_FragCoord.xy;
        vec2 screenPos = glyphPos / numColumns;
        float simTime = time * animationSpeed;

        // Read the current values of the glyph
        vec4 data = texture2D( lastState, screenPos );
        bool isInitializing = length(data) == 0.;
        float oldRainBrightness = data.r;
        float oldGlyphCycle = data.g;
        if (isInitializing) {
          oldGlyphCycle = showComputationTexture ? 0.5 : rand(screenPos);
        }

        float rainTime = getRainTime(simTime, glyphPos);
        float rainBrightness = getRainBrightness(rainTime);

        if (hasSun) rainBrightness = applySunShower(rainBrightness, screenPos);
        if (hasThunder) rainBrightness = applyThunder(rainBrightness, simTime, screenPos);

        float glyphCycleSpeed = getGlyphCycleSpeed(rainTime, rainBrightness);
        float glyphCycle = fract(oldGlyphCycle + 0.005 * animationSpeed * cycleSpeed * glyphCycleSpeed);

        float effect = 0.;
        effect = applyRippleEffect(effect, simTime, screenPos);
        effect = applyCursorEffect(effect, rainBrightness);

        float glyphDepth = rand(vec2(glyphPos.x, 0.0));

        if (rainBrightness > brightnessMinimum) {
          rainBrightness = rainBrightness * brightnessMultiplier + brightnessOffset;
        }

        if (!isInitializing) {
          rainBrightness = mix(oldRainBrightness, rainBrightness, brightnessMix);
        }

        if (showComputationTexture) {
          gl_FragColor = vec4(
            rainBrightness,
            glyphCycle,
            min(1.0, glyphCycleSpeed), // Better use of the blue channel, for show and tell
            1.0
          );
        } else {
          gl_FragColor = vec4(
            rainBrightness,
            glyphCycle,
            glyphDepth,
            effect
          );
        }
      }
    `,

    uniforms: {
      ...uniforms,
      lastState: doubleBuffer.back
    },

    framebuffer: doubleBuffer.front
  });

  const numGlyphs = numColumns * numColumns;

  const glyphPositions = Array(numColumns).fill().map((_, y) =>
    Array(numColumns).fill().map((_, x) =>
      Array(numVerticesPerGlyph).fill([x, y])
    )
  );
  const glyphCorners = Array(numGlyphs).fill([[0, 0], [0, 1], [1, 1], [0, 0], [1, 1], [1, 0]]);

  const depthMesh = {};
  Object.assign(depthMesh, {
    attributes: {
      aPosition: glyphPositions,
      aCorner: glyphCorners
    },
    count: numGlyphs * numVerticesPerGlyph,
  });

  // We render the code into an FBO using MSDFs: https://github.com/Chlumsky/msdfgen
  const render = regl({
    blend: {
      enable: true,
      func: {
        srcRGB: "src alpha",
        srcAlpha: 1,
        dstRGB: "dst alpha",
        dstAlpha: 1
      }
    },
    vert: `
      precision lowp float;
      attribute vec2 aPosition, aCorner;
      uniform float width, height;
      uniform float numColumns;
      uniform sampler2D lastState;
      varying vec2 vUV;
      varying vec4 vGlyph;
      uniform mat4 camera;
      uniform mat4 transform;
      uniform float time;
      uniform bool showComputationTexture;
      void main() {
        vUV = (aPosition + aCorner) / numColumns;
        vec2 position = (vUV - 0.5) * 2.0;
        vGlyph = texture2D(lastState, vUV + (0.5 - aCorner) / numColumns);

        float glyphDepth = showComputationTexture ? 0. : vGlyph.b;
        vec4 pos = camera * transform * vec4(position, glyphDepth, 1.0);

        // Scale the geometry to cover the longest dimension of the viewport
        // vec2 size = width > height ? vec2(width / height, 1.) : vec2(1., height / width);
        // pos.xy *= size;

        gl_Position = pos;
      }
    `,

    frag: `
      #define PI 3.14159265359
      #ifdef GL_OES_standard_derivatives
      #extension GL_OES_standard_derivatives: enable
      #endif
      precision lowp float;

      uniform float numColumns;
      uniform sampler2D glyphTex;
      uniform float glyphHeightToWidth, glyphSequenceLength, glyphTextureColumns, glyphEdgeCrop;
      uniform vec2 slantVec;
      uniform float slantScale;
      uniform bool isPolar;
      uniform bool showComputationTexture;

      varying vec2 vUV;
      varying vec4 vGlyph;

      float median3(vec3 i) {
        return max(min(i.r, i.g), min(max(i.r, i.g), i.b));
      }

      float getSymbolIndex(float glyphCycle) {
        float symbol = floor(glyphSequenceLength * glyphCycle);
        float symbolX = mod(symbol, glyphTextureColumns);
        float symbolY = ((glyphTextureColumns - 1.0) - (symbol - symbolX) / glyphTextureColumns);
        return symbolY * glyphTextureColumns + symbolX;
      }

      void main() {

        vec2 uv = vUV;

        if (isPolar) {
          // Curves the UV space to make letters appear to radiate from up above
          uv -= 0.5;
          uv *= 0.5;
          uv.y -= 0.5;
          float radius = length(uv);
          float angle = atan(uv.y, uv.x) / (2. * PI) + 0.5;
          uv = vec2(angle * 4. - 0.5, 1.5 - pow(radius, 0.5) * 1.5);
        } else {
          // Applies the slant, scaling the UV space
          // to guarantee the viewport is still covered
          uv = vec2(
          (uv.x - 0.5) * slantVec.x + (uv.y - 0.5) * slantVec.y,
          (uv.y - 0.5) * slantVec.x - (uv.x - 0.5) * slantVec.y
          ) * slantScale + 0.5;
        }

        uv.y /= glyphHeightToWidth;

        if (showComputationTexture) {
          gl_FragColor = vGlyph;
          return;
        }

        // Unpack the values from the font texture
        float brightness = vGlyph.r;
        float effect = vGlyph.a;
        brightness = max(effect, brightness);
        float symbolIndex = getSymbolIndex(vGlyph.g);

        // resolve UV to MSDF texture coord
        vec2 symbolUV = vec2(mod(symbolIndex, glyphTextureColumns), floor(symbolIndex / glyphTextureColumns));
        vec2 glyphUV = fract(uv * numColumns);
        glyphUV -= 0.5;
        glyphUV *= clamp(1.0 - glyphEdgeCrop, 0.0, 1.0);
        glyphUV += 0.5;
        vec2 msdfUV = (glyphUV + symbolUV) / glyphTextureColumns;

        // MSDF
        vec3 dist = texture2D(glyphTex, msdfUV).rgb;
        float sigDist = median3(dist) - 0.5;
        float alpha = clamp(sigDist/fwidth(sigDist) + 0.5, 0.0, 1.0);

        gl_FragColor = vec4(vec3(brightness * alpha), 1.0);
      }
    `,

    uniforms: {
      ...uniforms,
      camera: regl.prop("camera"),
      transform: regl.prop("transform"),
      glyphTex: msdfLoader.texture,
      height: regl.context("viewportWidth"),
      width: regl.context("viewportHeight"),
      lastState: doubleBuffer.front
    },

    ...depthMesh,

    framebuffer: output
  });

  const translation = glMatrix.vec3.set(glMatrix.vec3.create(), 0, 0, -1);
  const scale = glMatrix.vec3.set(glMatrix.vec3.create(), 3, 3, 1);

  return makePass(
    {
      primary: output
    },
    () => {

      const time = Date.now();

      glMatrix.mat4.identity(transform);
      glMatrix.mat4.translate(transform, transform, translation);
      glMatrix.mat4.scale(transform, transform, scale);
      glMatrix.mat4.rotateY(transform, transform, Math.PI * 2 * Math.sin(time * 0.001) * 0.05);

      update();
      regl.clear({
        depth: 1,
        color: [0, 0, 0, 1],
        framebuffer: output
      });
      render({camera, transform});
    },
    (w, h) => {
      output.resize(w, h);
      const aspectRatio = w / h;
      glMatrix.mat4.perspective(camera, (Math.PI / 180) * 150, aspectRatio, 0.0001, 1000);
    },
    msdfLoader.ready
  );
};