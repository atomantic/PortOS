import { createContext, useContext } from 'react';

const SidebarContext = createContext({ collapsed: false, desktop: false });

export const useSidebarContext = () => useContext(SidebarContext);

export default SidebarContext;
