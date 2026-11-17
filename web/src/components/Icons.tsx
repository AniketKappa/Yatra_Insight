// Inline stroke icons (24px grid, 1.75 stroke). Decorative by default (aria-hidden).
import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size = 18): SVGProps<SVGSVGElement> => ({
  width: size, height: size, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
  strokeWidth: 1.75, strokeLinecap: "round", strokeLinejoin: "round", "aria-hidden": true, focusable: false,
});
const I = (d: React.ReactNode) => ({ size, ...p }: P) => <svg {...base(size)} {...p}>{d}</svg>;

export const IconOverview = I(<><rect x="3" y="3" width="7" height="9" rx="1.5" /><rect x="14" y="3" width="7" height="5" rx="1.5" /><rect x="14" y="12" width="7" height="9" rx="1.5" /><rect x="3" y="16" width="7" height="5" rx="1.5" /></>);
export const IconProjects = I(<><path d="M3 7.5 12 3l9 4.5-9 4.5z" /><path d="m3 12 9 4.5 9-4.5" /><path d="m3 16.5 9 4.5 9-4.5" /></>);
export const IconSpark = I(<><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /><path d="m12 8 1.4 2.6L16 12l-2.6 1.4L12 16l-1.4-2.6L8 12l2.6-1.4z" /></>);
export const IconReport = I(<><path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" /><path d="M14 3v5h5M9 13h6M9 17h4" /></>);
export const IconAlert = I(<><path d="M10.3 3.9 2.4 17.5A2 2 0 0 0 4.1 20.5h15.8a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" /><path d="M12 9v4M12 17h.01" /></>);
export const IconSearch = I(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>);
export const IconMenu = I(<path d="M4 6h16M4 12h16M4 18h16" />);
export const IconX = I(<path d="M18 6 6 18M6 6l12 12" />);
export const IconSun = I(<><circle cx="12" cy="12" r="4" /><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4" /></>);
export const IconMoon = I(<path d="M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z" />);
export const IconSend = I(<><path d="M5 12h14M13 6l6 6-6 6" /></>);
export const IconStop = I(<rect x="7" y="7" width="10" height="10" rx="2" />);
export const IconArrowRight = I(<path d="M5 12h14M13 6l6 6-6 6" />);
export const IconArrowUp = I(<path d="M12 19V5M6 11l6-6 6 6" />);
export const IconArrowDown = I(<path d="M12 5v14M6 13l6 6 6-6" />);
export const IconCheck = I(<path d="m5 12.5 4.5 4.5L19 7.5" />);
export const IconCheckCircle = I(<><circle cx="12" cy="12" r="9" /><path d="m8 12.5 3 3 5-6" /></>);
export const IconWarn = I(<><circle cx="12" cy="12" r="9" /><path d="M12 7.5v5.5M12 16.5h.01" /></>);
export const IconOctagon = I(<><path d="M8.2 3h7.6L21 8.2v7.6L15.8 21H8.2L3 15.8V8.2z" /><path d="M9 9l6 6M15 9l-6 6" /></>);
export const IconPause = I(<><circle cx="12" cy="12" r="9" /><path d="M10 9v6M14 9v6" /></>);
export const IconClock = I(<><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>);
export const IconFlag = I(<><path d="M5 21V4M5 4h11l-2 4 2 4H5" /></>);
export const IconPlus = I(<path d="M12 5v14M5 12h14" />);
export const IconTrash = I(<><path d="M4 7h16M10 11v6M14 11v6" /><path d="M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3" /></>);
export const IconDownload = I(<><path d="M12 4v11M7 10l5 5 5-5" /><path d="M5 20h14" /></>);
export const IconPrint = I(<><path d="M7 9V3h10v6" /><rect x="3" y="9" width="18" height="8" rx="2" /><path d="M7 14h10v7H7z" /></>);
export const IconTable = I(<><rect x="3" y="4" width="18" height="16" rx="2" /><path d="M3 10h18M9 10v10" /></>);
export const IconChart = I(<><path d="M4 20V4M4 20h16" /><path d="m8 15 3-4 3 2 5-6" /></>);
export const IconDatabase = I(<><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" /></>);
export const IconChevronRight = I(<path d="m9 6 6 6-6 6" />);
export const IconChevronLeft = I(<path d="m15 6-6 6 6 6" />);
export const IconMapPin = I(<><path d="M12 21s-7-6.2-7-11.5A7 7 0 0 1 19 9.5C19 14.8 12 21 12 21z" /><circle cx="12" cy="9.5" r="2.5" /></>);
export const IconUser = I(<><circle cx="12" cy="8" r="4" /><path d="M4 21a8 8 0 0 1 16 0" /></>);
export const IconBuilding = I(<><rect x="4" y="3" width="16" height="18" rx="1.5" /><path d="M9 7h1M14 7h1M9 11h1M14 11h1M9 15h1M14 15h1" /></>);
export const IconCalendar = I(<><rect x="3" y="5" width="18" height="16" rx="2" /><path d="M3 10h18M8 3v4M16 3v4" /></>);
export const IconRupee = I(<><path d="M6 4h12M6 9h12M14 4c3 0 3 10-3 10H6l9 7" /></>);
export const IconRefresh = I(<><path d="M20 11a8 8 0 0 0-14.9-3.9L4 9M4 4v5h5M4 13a8 8 0 0 0 14.9 3.9L20 15M20 20v-5h-5" /></>);
export const IconEdit = I(<><path d="M4 20h4L19 9l-4-4L4 16z" /><path d="m13.5 6.5 4 4" /></>);
export const IconLogo = ({ size = 18 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
    <path d="M4 16.5 9 10l3.5 4L20 5.5" />
    <circle cx="20" cy="5.5" r="1.6" fill="currentColor" stroke="none" />
  </svg>
);
