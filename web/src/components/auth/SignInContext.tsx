"use client";

import { createContext, useContext, type ReactNode } from "react";

/** Whether operators sign in here (signInRequired() on the server): the session then authorizes commands */
const SignInContext = createContext(false);

export function SignInProvider({ required, children }: { required: boolean; children: ReactNode }) {
  return <SignInContext.Provider value={required}>{children}</SignInContext.Provider>;
}

export function useSignInRequired() {
  return useContext(SignInContext);
}
