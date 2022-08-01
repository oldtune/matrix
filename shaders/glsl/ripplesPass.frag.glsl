precision mediump float;
varying vec2 vUV;
uniform float width, height;
uniform float time;
uniform float intensity;
uniform float centerW;
uniform float centerH;
uniform sampler2D tex;
uniform sampler2D bloomTex;

void main() {
	vec2 iResolution = vec2(height,width);
	vec2 cp = vec2(
		-1. + 2.* gl_FragCoord.x /iResolution.x - centerW,
		-1. + 2.* gl_FragCoord.y /iResolution.y + centerH
	);
	float cl = length(cp);//*(intensity+1.)*.9;
    vec2 uv = gl_FragCoord.xy / iResolution.xy + (cp / cl / 2. ) * sin(cl*15. - time * 10.) * intensity*.5;
	vec3 col = texture2D(tex, uv).xyz + texture2D(bloomTex, uv).xyz;;
	col.y = col.x; col.x = 0.; col.z = 0.;
	gl_FragColor = vec4(col,1.0);
}