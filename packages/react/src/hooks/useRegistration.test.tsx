// @vitest-environment jsdom
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useRegistration } from "./useRegistration";

describe("useRegistration", () => {
  it("registers the value while mounted and re-registers on change", () => {
    const registered: string[] = [];
    const unregister = vi.fn();
    const register = (value: string) => {
      registered.push(value);
      return unregister;
    };
    const Probe = ({
      value,
      register: registerFn,
    }: {
      value: string;
      register: (value: string) => () => void;
    }) => {
      useRegistration(registerFn, value);
      return null;
    };

    const { rerender, unmount } = render(
      <Probe value="a" register={register} />
    );
    expect(registered).toEqual(["a"]);
    expect(unregister).not.toHaveBeenCalled();

    rerender(<Probe value="b" register={register} />);
    expect(registered).toEqual(["a", "b"]);
    expect(unregister).toHaveBeenCalledTimes(1);

    // A new registry (a remounted provider) re-registers the same value.
    const secondRegistered: string[] = [];
    const secondRegister = (value: string) => {
      secondRegistered.push(value);
      return vi.fn();
    };
    rerender(<Probe value="b" register={secondRegister} />);
    expect(secondRegistered).toEqual(["b"]);
    expect(unregister).toHaveBeenCalledTimes(2);

    unmount();
    expect(unregister).toHaveBeenCalledTimes(2);
  });
});
