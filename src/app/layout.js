// font disabled for offline automerge build
import { GoogleAnalytics } from "@next/third-parties/google";
import "./globals.css";
import { ThemeProvider } from "@/shared/components/ThemeProvider";
import "@/lib/network/initOutboundProxy"; // Auto-initialize outbound proxy env
import "@/shared/services/bootstrap"; // Auto-run initializeApp (watchdog, auto-resume tunnel)
import { initConsoleLogCapture } from "@/lib/consoleLogBuffer";
import { RuntimeI18nProvider } from "@/i18n/RuntimeI18nProvider";

// Hook console immediately at module load time (server-side only, runs once)
initConsoleLogCapture();

const inter = ({
  subsets: ["latin"],
  variable: "--font-inter",
});

export const metadata = {
  title: "9Router - AI Infrastructure Management",
  description: "One endpoint for all your AI providers. Manage keys, monitor usage, and scale effortlessly.",
  icons: {
    icon: "/favicon.svg",
  },
};

export const viewport = {
  themeColor: "#f7f1e4",
};

export default function RootLayout({ children }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Lock the neobrutalist theme before first paint. Dark variant from
            localStorage (freepi-theme), else system prefers-color-scheme. */}
        <script
          dangerouslySetInnerHTML={{
            __html: `var r=document.documentElement;r.classList.remove('glass','brutalist');r.classList.add('neobrutalism');try{var t=localStorage.getItem('freepi-theme');var dk=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;if(dk){r.classList.add('dark')}}catch(e){}`,
          }}
        />
        <script
          dangerouslySetInnerHTML={{
            /* Reveal icon glyphs once the icon font is usable. document.fonts.ready
               settles when font loading is idle, which is later and more reliable
               than a single load() callback (that one can resolve before the woff2
               is decoded). setTimeout is the backstop: icons must never stay at
               opacity 0 just because the font request was slow or failed. */
            __html: `var d=document,r=d.documentElement;r.classList.add('fonts-loading');var f=function(){r.classList.add('fonts-loaded');r.classList.remove('fonts-loading')};if(d.fonts&&d.fonts.ready){d.fonts.ready.then(f).catch(f);setTimeout(f,1500)}else{f()}`,
          }}
        />
      </head>
      <body className={`${inter.variable} font-sans antialiased`}>
        <ThemeProvider>
          <RuntimeI18nProvider>
            {children}
          </RuntimeI18nProvider>
        </ThemeProvider>
        <GoogleAnalytics gaId={"G-LC959F603F"} />
      </body>
    </html>
  );
}
