import { useState } from './react-stubs.js';

export function Button({ label }: { label: string }) {
  const [count, setCount] = useState(0);

  const handleClick = () => {
    setCount(count + 1);
  };

  // A button with an event handler attached by reference.
  return (
    <button onClick={handleClick} onMouseEnter={() => console.log('hover')}>
      {label} ({count})
    </button>
  );
}

// A second component with multiple handlers on one element.
export function Form() {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
      }}
      onReset={() => {}}
    >
      <input onChange={() => {}} />
    </form>
  );
}
