export type SiteRoute = "start" | "create" | "unity";

type TabDescriptor = {
  route: SiteRoute;
  label: string;
  href: string;
};

const tabs: TabDescriptor[] = [
  {
    route: "start",
    label: "Home",
    href: "/",
  },
  {
    route: "create",
    label: "Mint",
    href: "/create",
  },
  {
    route: "unity",
    label: "Play",
    href: "/unity",
  },
];

type Props = {
  activeRoute: SiteRoute;
};

export function SiteTabs({ activeRoute }: Props) {
  return (
    <nav className="site-tabs" aria-label="Pacific sections">
      {tabs.map((tab) => (
        <a
          key={tab.route}
          className={`site-tab ${tab.route === activeRoute ? "active" : ""}`}
          href={tab.href}
          aria-current={tab.route === activeRoute ? "page" : undefined}
        >
          {tab.label}
        </a>
      ))}
    </nav>
  );
}
