// Runtime OS detection — used by the hero CTA to highlight the matching
// platform button. Kept tiny on purpose; we don't ship any framework runtime,
// just a single inline <script> that toggles a [data-os] attribute.

export const detectScript = `
(function () {
  try {
    var ua = navigator.userAgent || '';
    var p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || '';
    var os = 'linux';
    if (/Mac|iPhone|iPod|iPad/.test(p) || /Mac OS X/.test(ua)) os = 'mac';
    else if (/Win/.test(p) || /Windows/.test(ua)) os = 'windows';
    else if (/Linux|X11|CrOS/.test(p) || /Linux/.test(ua)) os = 'linux';
    document.documentElement.setAttribute('data-os', os);
  } catch (e) {}
})();
`;
