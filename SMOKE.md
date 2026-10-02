# Manual smoke checklist

For anything the automated gate (`python scripts/smoke_test.py`) cannot see.
Walk this after changes that touch rendering, media, or outbound links.

1. Gate: globe spins behind three glass cards (Drive / Fly / Boat); hover lifts
   a card. Pick one and it drops into the planner.
2. Travel-mode switch: the Drive/Fly/Boat segmented control changes the plan.
   The "Pace" (hours/day) row shows only for Drive. Stop placeholders read
   "Start / Destination" for Drive, "Departure/Destination city" for Fly,
   "Departure/Destination port" for Boat.
3. Drive trip: a solid road route draws with overnight landing-zone rings on
   longer trips; the "Along the way" sight feed slides show real photos; the
   per-stop Stay/Do/Events/Videos sliders fill.
4. Fly / Boat trip: a dashed direct-line arc draws between the places you list
   (dotted for air, water-blue for sea); no landing rings, no "along the way"
   feed; each destination still gets its own Stay/Do/Events/Videos cards; the
   meta line and badge say "direct-line estimate".
5. Video card actions: MAP flies the map to that stop; BOOK opens a booking
   search in a new tab. Video plays in-app when the card body is tapped.
6. Sliders: Hotels/Motels/Airbnb/Eventbrite/YouTube links open the real
   platforms when a key is missing (honest fallback).
7. Re-center button restores the route after a manual pan.
8. Back button walks results -> gate; a copied `?mode=&stops=` URL restores the
   same trip in a new tab.
9. Phone width: sheet peeks, expands on header tap, chips are 44px.
