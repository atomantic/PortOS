export default function CoSAvatarFrame({ children, label = 'Interactive 3D avatar. Drag to rotate.', background = false }) {
  const a11yProps = background
    ? { 'aria-hidden': true }
    : { role: 'group', 'aria-label': label, title: 'Drag to rotate' };
  return (
    <div
      className={background
        ? 'relative w-full h-full min-h-full cursor-grab active:cursor-grabbing touch-none'
        : 'relative w-full max-w-[8rem] lg:max-w-[12rem] aspect-[5/6] cursor-grab active:cursor-grabbing touch-none'
      }
      {...a11yProps}
    >
      {children}
    </div>
  );
}
