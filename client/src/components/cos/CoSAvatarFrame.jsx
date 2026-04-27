export default function CoSAvatarFrame({ children, label = 'Interactive 3D avatar. Drag to rotate.' }) {
  return (
    <div
      className="relative w-full max-w-[8rem] lg:max-w-[12rem] aspect-[5/6] cursor-grab active:cursor-grabbing touch-none"
      title="Drag to rotate"
      role="img"
      aria-label={label}
    >
      {children}
    </div>
  );
}
