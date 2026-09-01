import * as Cesium from 'cesium';
import {
  CITY_POIS,
  DEFAULT_HOME_CITY_ID,
  flyToLandmark,
  flyToPresetLocation,
} from './locations.js';

/**
 * Camera presets for notable locations.
 * Default home is driven by DEFAULT_HOME_CITY_ID (ZA pack → Cape Town).
 */
export const CAMERA_PRESETS = {
  austin: {
    destination: Cesium.Cartesian3.fromDegrees(-97.7431, 30.2672, 800),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-35),
      roll: 0.0,
    },
  },
  sf: {
    destination: Cesium.Cartesian3.fromDegrees(-122.4194, 37.7749, 1000),
    orientation: {
      heading: Cesium.Math.toRadians(30),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  nyc: {
    destination: Cesium.Cartesian3.fromDegrees(-73.9857, 40.7484, 1200),
    orientation: {
      heading: Cesium.Math.toRadians(-20),
      pitch: Cesium.Math.toRadians(-30),
      roll: 0.0,
    },
  },
  'cape-town': {
    // Metro overview height — above Table Mountain / city bowl, not buried in it.
    destination: Cesium.Cartesian3.fromDegrees(18.45, -33.92, 22000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-45),
      roll: 0.0,
    },
  },
};

/**
 * Fly the camera to a preset location with a smooth animation.
 */
export function flyToPreset(viewer, presetName, duration = 3.0) {
  const preset = CAMERA_PRESETS[presetName];
  if (!preset) return;

  viewer.camera.flyTo({
    destination: preset.destination,
    orientation: preset.orientation,
    duration,
    easingFunction: Cesium.EasingFunction.CUBIC_IN_OUT,
  });
}

/**
 * Cinematic first-run fly-in to the fork's default home city (Cape Town via
 * the ZA city pack). Uses the city overview bounds so the opening view sits
 * above the mountains / city bowl — not the close Table Mountain landmark range.
 */
export function flyToDefaultHome(viewer) {
  const cityId = DEFAULT_HOME_CITY_ID;
  const city = CITY_POIS[cityId] || CITY_POIS.austin;
  const poi = city?.pois?.[0];
  if (!poi) return;

  // Start high over the home city, then settle into the metro overview frame.
  viewer.camera.setView({
    destination: Cesium.Cartesian3.fromDegrees(poi.lon, poi.lat, 120000),
    orientation: {
      heading: Cesium.Math.toRadians(0),
      pitch: Cesium.Math.toRadians(-90),
      roll: 0.0,
    },
  });

  setTimeout(() => {
    if (city.viewBounds) {
      flyToPresetLocation(viewer, cityId, {
        viewMode: 'overview',
        duration: 4.0,
      });
      return;
    }
    flyToLandmark(viewer, poi.lat, poi.lon, {
      range: Math.max(Number(poi.alt) || 0, 18000),
      pitch: -40,
      heading: poi.heading || 0,
      buildingHeight: poi.buildingHeight || 30,
      buildingBounds: poi.buildingBounds || null,
      groundElevation: city.groundElevation || 0,
      duration: 4.0,
    });
  }, 500);
}

/** @deprecated Use flyToDefaultHome — kept for older scripts/comments. */
export function flyToAustin(viewer) {
  flyToDefaultHome(viewer);
}
