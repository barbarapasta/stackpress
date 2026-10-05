//modules
import { Fragment, isValidElement } from 'react';
import type { ReactNode } from 'react';

//--------------------------------------------------------------------//
// A way to read markup without a browser

//No DOM library is installed in this repository, and none was added. The
// panel's components that draw (everything except the container and its
// hooks) call no hook, so each is a plain function from props to elements.
// This walks the elements those functions return, calling every component
// it meets, until only plain HTML elements are left. The result can be
// searched like a page, and its event handlers can be called as a click or
// a key press would call them. Whether the browser then fires them, and
// where focus goes, is for the real browser run, not for this.

export type Host = {
  tag: string,
  props: Record<string, any>,
  children: (Host | string)[]
};

type Part = Host | string;

/**
 * Turn what a component returns into plain elements and text.
 */
export function expand(node: ReactNode): Part[] {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return [];
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return [ String(node) ];
  }
  if (Array.isArray(node)) {
    return node.flatMap(child => expand(child));
  }
  if (!isValidElement(node)) return [];
  const { type, props } = node as {
    type: unknown, props: Record<string, any>
  };
  if (type === Fragment) return expand(props.children);
  if (typeof type === 'function') {
    return expand((type as (p: unknown) => ReactNode)(props));
  }
  const { children, ...rest } = props;
  return [ {
    tag: String(type),
    props: rest,
    children: expand(children)
  } ];
}

/**
 * One root, for a component that draws a single element.
 */
export function render(node: ReactNode): Host {
  const parts = expand(node);
  return parts[0] as Host;
}

export function walk(root: Part, visit: (host: Host) => void) {
  if (typeof root === 'string') return;
  visit(root);
  for (const child of root.children) walk(child, visit);
}

export function all(root: Part, test: (host: Host) => boolean) {
  const found: Host[] = [];
  walk(root, host => { if (test(host)) found.push(host); });
  return found;
}

export function first(root: Part, test: (host: Host) => boolean) {
  return all(root, test)[0];
}

/**
 * The text a node contains, as a reader would read it.
 */
export function text(part: Part | undefined): string {
  if (part === undefined) return '';
  if (typeof part === 'string') return part;
  return part.children.map(text).join('');
}

/**
 * The name a screen reader gives a control: its `aria-label`, or the label
 * pointing at it, or what it contains.
 */
export function name(root: Part, host: Host): string {
  if (host.props['aria-label']) return String(host.props['aria-label']);
  if (host.props.id) {
    const label = first(root, other => (
      other.tag === 'label' && other.props.htmlFor === host.props.id
    ));
    if (label) return text(label);
  }
  //a field inside a label is named by it
  const wrapping = all(root, other => (
    other.tag === 'label' && all(other, inner => inner === host).length > 0
  ))[0];
  if (wrapping) return text(wrapping).trim();
  if (host.props['aria-labelledby']) {
    const labelled = first(root, other => (
      other.props.id === host.props['aria-labelledby']
    ));
    if (labelled) return text(labelled);
  }
  return text(host).trim();
}

//the controls a person can reach and operate
const CONTROLS = [ 'button', 'a', 'select', 'textarea', 'input' ];

export function controls(root: Part) {
  return all(root, host => CONTROLS.includes(host.tag));
}

/**
 * A button, link or field by the name a person would give it.
 */
export function control(root: Part, label: string | RegExp) {
  const matches = (value: string) => (
    typeof label === 'string' ? value === label : label.test(value)
  );
  return controls(root).find(host => matches(name(root, host)));
}

export function mustControl(root: Part, label: string | RegExp) {
  const found = control(root, label);
  if (!found) {
    const have = controls(root).map(host => `${host.tag} "${name(root, host)}"`);
    throw new Error(`No control named ${label}. Have: ${have.join(', ')}`);
  }
  return found;
}

//--------------------------------------------------------------------//
// What a person does

const event = (extra: Record<string, unknown> = {}) => ({
  preventDefault() { /* nothing to prevent */ },
  stopPropagation() { /* nothing to stop */ },
  ...extra
});

/**
 * Click a control. A disabled control does nothing, as in a browser.
 */
export function click(host: Host) {
  if (host.props.disabled) return false;
  host.props.onClick?.(event());
  return true;
}

export function submit(form: Host) {
  form.props.onSubmit?.(event());
}

export function type(field: Host, value: string) {
  field.props.onChange?.(event({ target: { value } }));
}

export function press(
  host: Host,
  key: string,
  extra: Record<string, unknown> = {}
) {
  const pressed = event({
    key,
    shiftKey: false,
    target: { tagName: host.tag.toUpperCase() },
    nativeEvent: {},
    ...extra
  });
  host.props.onKeyDown?.(pressed);
  return pressed;
}

export function choose(select: Host, value: string) {
  select.props.onChange?.(event({ target: { value } }));
}

export function pick(input: Host, file: unknown) {
  const target = { files: file ? [ file ] : [], value: 'C:\\fakepath\\x' };
  input.props.onChange?.(event({ target }));
  return target;
}
