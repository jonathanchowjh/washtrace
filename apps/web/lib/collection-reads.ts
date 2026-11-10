import { cache } from 'react';
import { store } from './store';

/**
 * A collection and your lenses' runs on it, read once per request: its layout
 * (the tab bar) and the page under it, and a page's tab title, all need them.
 */
export const collectionOf = cache((chainId: number, address: string) => store().collection(chainId, address));

export const runsOf = cache((collectionId: number) => store().lensRuns(collectionId));
