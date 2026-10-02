// SafeRoute slim vendor build: globe.gl with tree-shaken THREE.
// The app's API contract (41 methods over points/arcs/rings/htmlElements/
// hexPolygons + globe/atmosphere/controls) is exercised by scripts/
// smoke_test.py and the pixel gate before this build may ship.
import Globe from 'globe.gl';
export default Globe;
