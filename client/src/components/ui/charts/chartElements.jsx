import { Children, Fragment, isValidElement } from 'react';

// These elements declare a plot. Its renderer owns the single SVG coordinate system.
export function XAxis() {}
export function YAxis() {}
export function Line() {}
export function Bar() {}
export function CartesianGrid() {}
export function ReferenceLine() {}
export function Tooltip() {}
export function Legend() {}
export function Cell() {}
export function Scatter() {}
export function LabelList() {}
export function Radar() {}
export function PolarGrid() {}
export function PolarAngleAxis() {}
export function PolarRadiusAxis() {}

export function elements(children, type) {
  return Children.toArray(children).flatMap(child => {
    if (!isValidElement(child)) return [];
    if (child.type === Fragment) return elements(child.props.children, type);
    return child.type === type ? [child.props] : [];
  });
}
