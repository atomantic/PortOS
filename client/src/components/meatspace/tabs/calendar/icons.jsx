import {
  Coffee, Droplets, Utensils, Dumbbell, BookOpen, Scissors,
  Cake, Plane, Circle, Sun, Moon,
} from 'lucide-react';

export const ICON_MAP = {
  coffee: Coffee, droplets: Droplets, utensils: Utensils, dumbbell: Dumbbell,
  'book-open': BookOpen, scissors: Scissors, cake: Cake, plane: Plane,
  circle: Circle, sun: Sun, moon: Moon,
};

export function IconForName({ name, size = 16, className }) {
  const Comp = ICON_MAP[name] || Circle;
  return <Comp size={size} className={className} />;
}
