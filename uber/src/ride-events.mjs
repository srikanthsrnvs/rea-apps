/** Bounded per-feed ride observations. A new viewer starts a new journal. */
export class RideEvents {
  constructor() {
    this.tripId = null;
    this.previous = null;
    this.events = [];
    this.sequence = 0;
  }
  observe(scene) {
    if (scene.kind !== 'ride' || !scene.tripId) return scene;
    if (this.tripId && this.tripId !== scene.tripId)
      throw new Error('Ride events changed selected trip');
    this.tripId = scene.tripId;
    const previous = this.previous;
    // A terminal snapshot cannot be resurrected by late coordinates/status.
    if (previous?.state === 'ended')
      return {
        ...previous,
        rideEvents: [...this.events],
        eventCursor: this.sequence,
      };
    const append = (type, detail) => {
      const sequence = ++this.sequence;
      this.events.push({
        id: `${this.tripId}:${sequence}`,
        sequence,
        tripId: this.tripId,
        observedAt: scene.observedAt,
        type,
        ...detail,
      });
      if (this.events.length > 128) this.events.shift();
    };
    if (!previous || previous.ride.phase !== scene.ride.phase)
      append('ride.phase_changed', {
        phase: scene.ride.phase,
        title: scene.ride.statusTitle,
      });
    if (
      scene.ride.driver?.id &&
      scene.ride.driver.id !== previous?.ride.driver?.id
    )
      append('ride.driver_assigned', { driverId: scene.ride.driver.id });
    const etaValues = (value) => [
      value?.pickupMinutes,
      value?.pickupDisplay,
      value?.destinationMinutes,
      value?.destinationDisplay,
    ];
    if (
      scene.state !== 'ended' &&
      (!previous ||
        JSON.stringify(etaValues(scene.eta)) !==
          JSON.stringify(etaValues(previous?.eta)))
    )
      append('ride.eta_changed', { eta: scene.eta });
    if (
      scene.driver?.position &&
      JSON.stringify(scene.driver.position) !==
        JSON.stringify(previous?.driver?.position)
    )
      append('ride.driver_position', { position: scene.driver.position });
    this.previous = scene;
    return {
      ...scene,
      rideEvents: [...this.events],
      eventCursor: this.sequence,
    };
  }
}
