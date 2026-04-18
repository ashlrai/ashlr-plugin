"use client";

// Pure-SVG terminal mock with CSS-keyframe animations.
// Sparkline cycles at 120ms (FRAME_MS match). Activity indicator fades 4s.
// Counter increments every 2s. prefers-reduced-motion: static frame.
// Width 640 logical px, height auto via viewBox + preserveAspectRatio.

export default function TerminalMock() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 640 148"
      width="640"
      height="148"
      role="img"
      aria-label="ashlr terminal status: session savings +432.5K, lifetime +4.3M"
      preserveAspectRatio="xMidYMid meet"
      style={{ width: "100%", maxWidth: 640, height: "auto", display: "block" }}
    >
      <defs>
        <style>{`
          @media (prefers-reduced-motion: no-preference) {
            .sp-c0 { animation: sp-cycle 720ms steps(1, end) 0ms    infinite; }
            .sp-c1 { animation: sp-cycle 720ms steps(1, end) 120ms  infinite; }
            .sp-c2 { animation: sp-cycle 720ms steps(1, end) 240ms  infinite; }
            .sp-c3 { animation: sp-cycle 720ms steps(1, end) 360ms  infinite; }
            .sp-c4 { animation: sp-cycle 720ms steps(1, end) 480ms  infinite; }
            .sp-c5 { animation: sp-cycle 720ms steps(1, end) 600ms  infinite; }
            .sp-c6 { animation: sp-cycle 720ms steps(1, end) 480ms  infinite; }
            .sp-c7 { animation: sp-cycle 720ms steps(1, end) 360ms  infinite; }
            @keyframes sp-cycle {
              0%    { fill: rgba(79,91,63,0.28); }
              16.6% { fill: rgba(79,91,63,0.44); }
              33.3% { fill: rgba(79,91,63,0.58); }
              50%   { fill: rgba(79,91,63,0.72); }
              66.6% { fill: rgba(79,91,63,0.87); }
              83.3% { fill: rgba(79,91,63,1.00); }
            }
            .act-up { animation: act-fade 4s ease-in-out infinite; }
            @keyframes act-fade {
              0%,100% { opacity: 0.25; }
              50%      { opacity: 1;    }
            }
            .ctr-v1 { animation: ctr-show1 6s steps(1,end) infinite; }
            .ctr-v2 { animation: ctr-show2 6s steps(1,end) infinite; }
            .ctr-v3 { animation: ctr-show3 6s steps(1,end) infinite; }
            @keyframes ctr-show1 {
              0%     { opacity: 1; }
              33.4%  { opacity: 0; }
              100%   { opacity: 0; }
            }
            @keyframes ctr-show2 {
              0%     { opacity: 0; }
              33.3%  { opacity: 1; }
              66.7%  { opacity: 0; }
              100%   { opacity: 0; }
            }
            @keyframes ctr-show3 {
              0%     { opacity: 0; }
              66.6%  { opacity: 0; }
              66.7%  { opacity: 1; }
              99.9%  { opacity: 1; }
              100%   { opacity: 0; }
            }
            .cursor-blink { animation: cur-blink 1.2s step-end infinite; }
            @keyframes cur-blink {
              0%,100% { opacity: 1; }
              50%     { opacity: 0; }
            }
          }
          @media (prefers-reduced-motion: reduce) {
            .sp-c0,.sp-c1,.sp-c2,.sp-c3,.sp-c4,.sp-c5,.sp-c6,.sp-c7 {
              fill: rgba(79,91,63,0.75);
            }
            .act-up       { opacity: 0.7; }
            .ctr-v1       { opacity: 1; }
            .ctr-v2       { opacity: 0; }
            .ctr-v3       { opacity: 0; }
            .cursor-blink { opacity: 1; }
          }
        `}</style>
      </defs>

      {/* Window background */}
      <rect width="640" height="148" rx="6" fill="#ECE2CE" />

      {/* Title bar */}
      <rect width="640" height="36" rx="6" fill="#F3EADB" />
      <rect x="0" y="35" width="640" height="1" fill="rgba(18,18,18,0.09)" />

      {/* Traffic lights */}
      <circle cx="18" cy="18" r="5" fill="#8B2E1A" fillOpacity="0.75" />
      <circle cx="34" cy="18" r="5" fill="rgba(18,18,18,0.28)" />
      <circle cx="50" cy="18" r="5" fill="rgba(18,18,18,0.28)" />

      {/* Title */}
      <text x="320" y="22" textAnchor="middle"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="10" letterSpacing="1.4" fill="rgba(18,18,18,0.30)">
        ashlr · plugin.ashlr.ai
      </text>

      {/* Line 1: prompt */}
      <text x="20" y="62"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="rgba(18,18,18,0.28)">$</text>
      <text x="33" y="62"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="rgba(18,18,18,0.82)">/ashlr-savings</text>

      {/* Cursor after prompt */}
      <rect x="138" y="50" width="7" height="13" fill="rgba(18,18,18,0.55)"
        className="cursor-blink" />

      {/* Line 2: status line */}
      {/* ashlr brand */}
      <text x="20" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fontWeight="600" fill="#8B2E1A">ashlr</text>
      <text x="63" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="rgba(18,18,18,0.28)">·</text>
      <text x="74" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="rgba(18,18,18,0.55)">7d</text>

      {/* Sparkline: ▁▂▃▅▇█⣧█ */}
      {([
        [96,  "\u2581", "sp-c0"],
        [106, "\u2582", "sp-c1"],
        [116, "\u2583", "sp-c2"],
        [126, "\u2585", "sp-c3"],
        [136, "\u2587", "sp-c4"],
        [146, "\u2588", "sp-c5"],
        [156, "\u28E7", "sp-c6"],
        [166, "\u2588", "sp-c7"],
      ] as [number, string, string][]).map(([x, char, cls]) => (
        <text key={x} x={x} y={90}
          fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
          fontSize="12.5" className={cls} fill="rgba(79,91,63,0.75)">{char}</text>
      ))}

      <text x="178" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="rgba(18,18,18,0.28)">·</text>
      <text x="189" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="rgba(18,18,18,0.55)">session</text>

      {/* Activity up arrow */}
      <text x="244" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fontWeight="600" fill="#8B2E1A" className="act-up">&#x2191;</text>

      {/* Counter — three stacked texts, one visible at a time */}
      <text x="255" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fontWeight="600" fill="#8B2E1A" className="ctr-v1">+432.5K</text>
      <text x="255" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fontWeight="600" fill="#8B2E1A" className="ctr-v2">+432.8K</text>
      <text x="255" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fontWeight="600" fill="#8B2E1A" className="ctr-v3">+433.1K</text>

      <text x="305" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="rgba(18,18,18,0.28)">·</text>
      <text x="316" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="rgba(18,18,18,0.55)">lifetime</text>
      <text x="373" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fontWeight="600" fill="#8B2E1A">+4.3M</text>
      <text x="410" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="rgba(18,18,18,0.28)">·</text>
      <text x="421" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="rgba(18,18,18,0.28)">tip:</text>
      <text x="448" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="#4F5B3F">ashlr__edit</text>
      <text x="527" y="90"
        fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
        fontSize="12.5" fill="rgba(18,18,18,0.55)">ships diffs</text>

      {/* Recent ops rows */}
      {([
        [118, "ashlr__read", "src/genome/retriever.ts",    "-1,595 tok", "79.7%"],
        [134, "ashlr__read", "src/compression/context.ts", "-1,111 tok", "73.2%"],
      ] as [number, string, string, string, string][]).map(([y, tool, file, saved, pct]) => (
        <g key={y}>
          <text x="20" y={y}
            fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
            fontSize="11" fill="rgba(18,18,18,0.28)">{tool}</text>
          <text x="108" y={y}
            fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
            fontSize="11" fill="rgba(18,18,18,0.55)">{file}</text>
          <text x="490" y={y}
            fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
            fontSize="11" fontWeight="500" fill="#8B2E1A">{saved}</text>
          <text x="574" y={y}
            fontFamily="'JetBrains Mono','Fira Code',ui-monospace,monospace"
            fontSize="11" fill="#4F5B3F">{pct}</text>
        </g>
      ))}
    </svg>
  );
}
