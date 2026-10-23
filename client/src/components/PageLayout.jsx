// Keep page chrome outside the content gutters and scroll region. Editors may
// replace bodyClassName when their panes own scrolling; ordinary pages retain
// one padded scroll owner. PageHeader and TabPills keep their own touch spacing.
export default function PageLayout({ header, navigation, children, className = '', bodyClassName = 'overflow-auto p-4 md:p-6' }) {
  return (
    <div className={`flex h-full min-h-0 min-w-0 flex-col ${className}`}>
      {header}
      {navigation}
      <div className={`flex-1 min-h-0 min-w-0 ${bodyClassName}`}>
        {children}
      </div>
    </div>
  );
}
