export default function CoSAvatarFrame({ children, label = 'Interactive 3D avatar. Drag to rotate.', background = false }) {
  return (
    <div
      className={background
        ? 'relative w-full h-full min-h-full cursor-grab active:cursor-grabbing touch-none'
        : 'relative w-full max-w-[8rem] lg:max-w-[12rem] aspect-[5/6] cursor-grab active:cursor-grabbing touch-none'
      }
      title="Drag to rotate"
      role="group"
      aria-label={label}
    >
      {children}
    </div>
  );
}
