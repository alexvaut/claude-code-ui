Bugs
- many tasks show up in tasks approval while it's wrong
- When receive a permission request, move internal state to a new state "request approval check", however we don't expose it to the UI, 
the map it for the UI to working, at the same time we run a timer that will trigger a signal in 3 seconds. WHen the timer is ON if it detects the state has not move **at all** (be careful it could have moved and be back here) then it triggers a transition "request approval confirmed"

P1
- session in claude code desktop don't show up


P2
- task management if it becomes a central place, possibly linked with a real issue system if needed
- artifacts management (logs, screenshots, summary review...)


P3
- Conversation with agents graphically displayed would be nice