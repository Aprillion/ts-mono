import { createContext, useContext, type ReactNode } from "react";

import type { ChatMessage } from "@tsmono/inspect-common/types";

import type { FieldIdentity } from "./searchFieldIdentity";

/**
 * Carries an event's searchable-field identities down to the chat views so they
 * can stamp `data-search-*` on each body's canonical element. Looked up by the
 * message object reference, so identity assignment stays anchored to the shared
 * enumerator (`eventSearchFields`) rather than re-derived per render position.
 *
 * Absent outside the searchable transcript (e.g. the standalone Messages tab),
 * in which case no annotation happens. See design/transcript-find-spec.md
 * "Renderer annotation".
 */
export interface SearchFieldContextValue {
  identitiesForMessage: (message: ChatMessage) => FieldIdentity[] | undefined;
}

const SearchFieldContext = createContext<SearchFieldContextValue | null>(null);

export const SearchFieldProvider = ({
  value,
  children,
}: {
  value: SearchFieldContextValue;
  children: ReactNode;
}) => (
  <SearchFieldContext.Provider value={value}>
    {children}
  </SearchFieldContext.Provider>
);

/** Identities of the given message's in-scope markdown bodies, in render order. */
export const useMessageSearchIdentities = (
  message: ChatMessage
): FieldIdentity[] | undefined => {
  const context = useContext(SearchFieldContext);
  return context?.identitiesForMessage(message);
};
