# The console

For people reading verdicts in the console: what each page shows, the words it uses, and how to write a lens of
your own. The console runs on port 8080 (see the README's [Quick start](../README.md#quick-start)); everything it
shows is also in the [API](api.md).

## Pages

| Route | Content | Refresh |
|---|---|---|
| `/` | Watched collections, each with the share of its sales and volume that looks washed (Round trips to Linked wallets) and how complete the reading is. A form to watch another. | 15 s |
| `/c/{chain}/{address}` | One collection at a glance: the reading in four steps, the answer as that range, how sure each end is (the floor, what the ceiling adds, and Money loops back apart), every sale in order, the tokens and wallets most flagged ETH went through, what looks suspicious but is not counted, and your lenses. | 15 s |
| `/c/{chain}/{address}/methods` | What the overview stands on: a tab per lens with its tokens and wallets, writing your own, each lens's share over time, and the six stages of the reading. Old `?method=` links to the overview come here. | 15 s |
| `/c/{chain}/{address}/rings` | Every [ring](methods.md#rings), the most ETH first, 20 a page: its wallets, tokens, flagged sales and ETH, each opening what it counts. | On open |
| `/c/{chain}/{address}/r/{anchor}` | One ring, named by its smallest wallet: its loops drawn as a token's graph (its tokens changing hands between its wallets, and the money among them; a ring of more than 25 wallets is listed, not drawn), who traded, who only moved the money, its tokens, and its sales (Trades with `?ring=`). A token, wallet or trade page in it says "Part of Ring N". | On open |
| `/c/{chain}/{address}/tokens`, `/wallets` | Every token or wallet one lens flags, most flagged first. `?method=AU&page=2`. The old `/flagged?kind=` links redirect here. | On open |
| `/c/{chain}/{address}/trades` | The collection's trades, filtered by lens, market, price, date, wallet and token, with a CSV download. | On open |
| `/c/{chain}/{address}/t/{tokenId}` | One token: its verdict, the graph as in the paper's Figure 8, and every transfer. | On open |
| `/w/{chain}/{address}` | One wallet: how many of its trades are flagged, whether its money has been read, and who it moved money with. | On open |
| `/c/{chain}/{address}/w/{wallet}`, `/tx/{hash}` | A wallet or a transaction opened from a collection: the same page under its tabs, with the wallet's trades and counts in that collection alone. Links from a collection's pages open these. | On open |
| `/tx/{chain}/{hash}` | One transaction's verdict, and [Check this transaction](#checking-a-transaction-you-do-not-watch) where washtrace has not read or judged it. | On open |
| `/search?q=` | A collection name, token number (`#1234`), wallet address or transaction hash. The sidebar search goes to the one thing it finds (via `/go`), else here. A hash nothing watched matches links to its transaction page on each chain the worker has an RPC for. Under a collection the box searches that collection (its tokens and the wallets that traded it), said in its placeholder and on a chip that drops the scope; `/` focuses it, and its list leads with the kind typed; a wallet that is the best match there has its rings and most-traded tokens listed under it. | On open |
| `/lab` | Your lenses side by side: each rule as a picture and in words, and every watched collection it runs on, with its share, what data it still needs there, and a tick to run it on more (Run on N). Each row has its own Preview, started only by its button, since previews run one at a time on the worker. Writing and editing a lens stay on a collection's Methods page, where its data is; the editor's *Also run it on* ticks other collections, and its button becomes Save and run on N. | On open |
| `/settings` | The settings in [operating.md](operating.md#settings), where each value came from, and a Test for the RPC and Etherscan. | On open |
| `/worker` | What needs a person, the four jobs, the sources, every collection's stages. | 5 s |

Every page of a collection sits under one line naming it and a tab bar: Overview, Rings, Tokens, Wallets and
Trades. A ring lights Rings; a token lights Tokens, the list it belongs to; a wallet Wallets, a transaction Trades. Tokens and Wallets count Linked wallets' lists, and the count hides
while another lens is chosen, since it would not match the list; a lens chosen on one tab is kept on the others.

A token, wallet, trade or ring page under a collection says what it is the same way. Under its title are its
kind, a verdict chip naming the lens tier behind it (Round trips, the floor; Linked wallets, the ceiling; Money
loops back, not counted) and the rings it is part of. Below its answer is the strip of every sale of the
collection, with its own sales outlined, then a **Connected to** panel in one order. It shows what it is part of
(the collection and its washed share, its rings, a trade's token), the wallets here with their role (seller,
buyer, funder, payee, in between), and the sales and payments that tie them, by block.

A token, wallet, ring or trade opened from a collection's list carries `?from=`, the list it came from. A line above
its title leads back to that list, says where the item sits in it, and steps to the item before and after, across
pages too (‹ ›, or K and J). The item is found in the list by what it is, so after a new analysis reorders the list,
one no longer on its page shows no steps.

Resting the pointer on (or tabbing to) a wallet, token or ring link inside a collection shows a small card: its trades
here and how many are flagged, its ring, or a ring's size. Clicking still opens the page.

Times are clock times in the reader's time zone, changeable at the foot of the sidebar.

## Words it uses

### Reading a verdict

- **Lens.** One rule for what counts as a wash trade: the three methods, and [yours](#your-own-lenses).
- **Share.** The part of the trades a lens judged that it flags. The collection page leads with sales; the
  analysis also gives changes of owner and volume.
- **Judged.** Looked at by a lens. "Not judged yet" is a trade past the block the latest analysis or run read to,
  never shown as clean. Burns and moves into or out of custody are not trades and are never judged.
- **So far / at least.** "So far": reads still running can move the share. "At least": waiting will not close it
  (a search cap, a missing Etherscan key, a limit).

### Reading money

- **Money read.** How many traders are checked, and how many wallets out the worker follows.
- **Wallets out.** Hops of money followed out of a trader (`follow.hops`, "Follow money (wallets out)"), so a
  payment can return through wallets that never traded the collection.
- **Wallets between.** The wallets on a loop between seller and buyer.
- **Reach.** The wallets a collection's money has been walked to. The console says "Finding the wallets up to N
  wallets out".
- **Read again.** Reading a trader's money and other tokens a second time after it trades again
  (`follow.reread`, off by default; see [operating.md](operating.md#reading-traders-again)).
- **Other tokens.** An edge type for payments in a fixed list of tokens (USDC, USDT, DAI and APE on Ethereum; USDC
  and DAI on Base; none elsewhere), with no smallest amount: washtrace has no prices.
- **Payees.** The wallets a trader paid in those tokens; reading their tokens too is off by default
  (`tokens.payees`).

### In a token's graph

- **Custody.** A contract holding a token without owning it, such as a Blur Blend loan. A → escrow → B is one hop
  A → B; A → escrow → A is none.
- **Bridge.** The paper's fix for missing transfers: an unobserved edge from a token's last holder to the next
  sender. Never flagged or counted; the console does not name it.

## Your own lenses

A lens of yours sits beside the three methods on a collection's page; **Copy to new lens** starts from one of
them. The editor sets which edges may carry the way back to the seller (NFT transfers, ETH, internal ETH, WETH
including Blur Pool, Other tokens), the wallets between seller and buyer, a time window, and which trades it
judges (sales, or every change of owner). **Advanced** shows the rest: each edge's direction, limit, smallest
payment and repeat rule, where the loop closes, the order in time, how many loops a trade needs, and wallets a
loop never passes through.

**Data this lens needs** says which reads the rule is short of, money that many wallets out or Other tokens; a
button asks the worker for them, and the share reads "so far" meanwhile. **Preview** tries the unsaved rule on a
sample of 2,000 sales (`PREVIEW_SAMPLE`) and compares its catch with Round trips. **Save and run** queues the
lens's run. The lens routes are in [api.md](api.md).

## Checking a transaction you do not watch

Where a transaction's page says washtrace has not read it, or has not judged it yet, a **Check this transaction**
panel sits under the answer. It asks the worker for a spot check: the transaction's receipt, each of its tokens'
histories, and the money of its sellers and buyers, without watching the collection.

- **Judge with** is **Built-in methods** (Round trips and Linked wallets) by default, or one of your lenses. A lens
  a spot check cannot run, one using Other tokens or the collection's other tokens, is shown greyed out with why.
- The answer arrives in seconds, polled every second: which lens flagged it, each flagged token with why and links
  to the wallets involved, and what could not run. Money loops back never runs on a spot check.
- "At least" means some wallets could not be judged, so the answer is not clean. "This block is not final yet"
  means the answer may change.
- A check that fails says why (an unknown transaction, an ERC-1155 transfer, a chain with no RPC) and has **Try
  again**.
- Where this console may not be written to, the button is greyed out, as Save is.

What a spot check can and cannot say is in the README's [Not watched yet?](../README.md#not-watched-yet), and its
routes in [api.md](api.md#spot-checks).
