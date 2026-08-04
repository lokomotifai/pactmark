import { toSafeText } from "../../src/safe-text";

export function TextPanel(props: Readonly<{ title: string; value: unknown; empty: string }>) {
  const present = props.value !== undefined && props.value !== null && props.value !== "";
  return (
    <section className="panel" aria-labelledby={`${props.title.replaceAll(" ", "-")}-title`}>
      <h2 id={`${props.title.replaceAll(" ", "-")}-title`}>{props.title}</h2>
      <pre tabIndex={0}>{present ? toSafeText(props.value) : props.empty}</pre>
    </section>
  );
}
