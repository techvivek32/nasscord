import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";
import { RevealRoot } from "@/components/marketing/reveal";
import { SITE_FONT_CLASSES } from "@/components/marketing/site-fonts";

/**
 * Public site chrome. Loads the website's own type and color theme (.site-theme in globals.css) so the website can
 * look different from the app areas, and mounts the scroll-reveal observer.
 */
export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className={`site-theme ${SITE_FONT_CLASSES} flex min-h-full flex-col`}>
      <SiteHeader />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
      <RevealRoot />
    </div>
  );
}
