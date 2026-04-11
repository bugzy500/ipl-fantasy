import { PlayerPerformance, ScoreBreakdownSection } from '../../../core/models/api.models';

export function strikeRate(perf: PlayerPerformance): string {
  if (!perf.ballsFaced) return '0.00';
  return ((perf.runs / perf.ballsFaced) * 100).toFixed(2);
}

export function economy(perf: PlayerPerformance): string {
  if (!perf.oversBowled) return '0.00';
  return (perf.runsConceded / perf.oversBowled).toFixed(2);
}

export function summaryPills(perf: PlayerPerformance): string[] {
  const pills: string[] = [];
  if (perf.didBat) {
    pills.push(`${perf.runs} (${perf.ballsFaced}b)`);
    if (perf.ballsFaced >= 10) pills.push(`SR ${strikeRate(perf)}`);
  }
  if (perf.oversBowled > 0) {
    pills.push(`${perf.wickets}/${perf.runsConceded} in ${perf.oversBowled} ov`);
    if (perf.oversBowled >= 2) pills.push(`Econ ${economy(perf)}`);
  }
  if (perf.catches > 0) pills.push(`${perf.catches} catch${perf.catches === 1 ? '' : 'es'}`);
  if (perf.stumpings > 0) pills.push(`${perf.stumpings} stumping${perf.stumpings === 1 ? '' : 's'}`);
  if (perf.runOutDirect > 0) pills.push(`${perf.runOutDirect} direct RO`);
  if (perf.runOutIndirect > 0) pills.push(`${perf.runOutIndirect} assist RO`);
  return pills.length > 0 ? pills : ['No scoring events yet'];
}

export function buildFallbackBreakdown(perf: PlayerPerformance): { total: number; sections: ScoreBreakdownSection[] } {
  const sections: ScoreBreakdownSection[] = [];

  if (perf.didBat) {
    const items = [
      { label: 'Runs scored', detail: `${perf.runs} runs x 1`, points: perf.runs },
    ];

    if (perf.fours > 0) items.push({ label: 'Boundary bonus', detail: `${perf.fours} fours x 1`, points: perf.fours });
    if (perf.sixes > 0) items.push({ label: 'Six bonus', detail: `${perf.sixes} sixes x 2`, points: perf.sixes * 2 });
    if (perf.runs >= 100) items.push({ label: 'Century bonus', detail: '100+ runs', points: 16 });
    else if (perf.runs >= 50) items.push({ label: 'Half-century bonus', detail: '50+ runs', points: 8 });
    if (perf.isDismissed && perf.runs === 0 && perf.playerId.role !== 'BOWL') {
      items.push({ label: 'Duck penalty', detail: 'Dismissed for 0', points: -2 });
    }

    if (perf.ballsFaced >= 10) {
      const sr = (perf.runs / perf.ballsFaced) * 100;
      let srPoints = 0;
      let srLabel = 'No modifier';
      if (sr > 170) { srPoints = 6; srLabel = '> 170'; }
      else if (sr > 150) { srPoints = 4; srLabel = '150.01 - 170'; }
      else if (sr >= 130) { srPoints = 2; srLabel = '130 - 150'; }
      else if (sr >= 60 && sr <= 70) { srPoints = -2; srLabel = '60 - 70'; }
      else if (sr >= 50 && sr < 60) { srPoints = -4; srLabel = '50 - 59.99'; }
      else if (sr < 50) { srPoints = -6; srLabel = '< 50'; }
      items.push({ label: 'Strike-rate modifier', detail: `SR ${sr.toFixed(2)} (${srLabel})`, points: srPoints });
    }

    sections.push({
      key: 'batting',
      label: 'Batting',
      subtotal: items.reduce((sum, item) => sum + item.points, 0),
      items,
    });
  }

  if (perf.oversBowled > 0) {
    const items = [];
    if (perf.wickets > 0) items.push({ label: 'Wickets', detail: `${perf.wickets} wickets x 25`, points: perf.wickets * 25 });
    if (perf.lbwBowledWickets > 0) items.push({ label: 'LBW / bowled bonus', detail: `${perf.lbwBowledWickets} wickets x 8`, points: perf.lbwBowledWickets * 8 });
    if (perf.maidens > 0) items.push({ label: 'Maiden overs', detail: `${perf.maidens} maidens x 12`, points: perf.maidens * 12 });
    if (perf.dotBalls > 0) items.push({ label: 'Dot balls', detail: `${perf.dotBalls} dot balls x 2`, points: perf.dotBalls * 2 });
    if (perf.wickets >= 5) items.push({ label: '5-wicket haul bonus', detail: `${perf.wickets} wickets`, points: 16 });
    else if (perf.wickets >= 4) items.push({ label: '4-wicket haul bonus', detail: `${perf.wickets} wickets`, points: 8 });

    if (perf.oversBowled >= 2) {
      const econ = perf.runsConceded / perf.oversBowled;
      let econPoints = 0;
      let econLabel = 'No modifier';
      if (econ < 5) { econPoints = 6; econLabel = '< 5'; }
      else if (econ < 6) { econPoints = 4; econLabel = '5 - 5.99'; }
      else if (econ <= 7) { econPoints = 2; econLabel = '6 - 7'; }
      else if (econ >= 10 && econ <= 11) { econPoints = -2; econLabel = '10 - 11'; }
      else if (econ > 11 && econ <= 12) { econPoints = -4; econLabel = '11.01 - 12'; }
      else if (econ > 12) { econPoints = -6; econLabel = '> 12'; }
      items.push({ label: 'Economy modifier', detail: `Econ ${econ.toFixed(2)} (${econLabel})`, points: econPoints });
    }

    sections.push({
      key: 'bowling',
      label: 'Bowling',
      subtotal: items.reduce((sum, item) => sum + item.points, 0),
      items,
    });
  }

  const fieldingItems = [];
  if (perf.catches > 0) {
    fieldingItems.push({ label: 'Catches', detail: `${perf.catches} catches x 8`, points: perf.catches * 8 });
    if (perf.catches >= 3) fieldingItems.push({ label: '3-catch bonus', detail: `${perf.catches} catches`, points: 4 });
  }
  if (perf.stumpings > 0) fieldingItems.push({ label: 'Stumpings', detail: `${perf.stumpings} stumpings x 12`, points: perf.stumpings * 12 });
  if (perf.runOutDirect > 0) fieldingItems.push({ label: 'Direct run-outs', detail: `${perf.runOutDirect} direct run-outs x 12`, points: perf.runOutDirect * 12 });
  if (perf.runOutIndirect > 0) fieldingItems.push({ label: 'Indirect run-outs', detail: `${perf.runOutIndirect} assists x 6`, points: perf.runOutIndirect * 6 });

  if (fieldingItems.length > 0) {
    sections.push({
      key: 'fielding',
      label: 'Fielding',
      subtotal: fieldingItems.reduce((sum, item) => sum + item.points, 0),
      items: fieldingItems,
    });
  }

  return {
    total: sections.reduce((sum, section) => sum + section.subtotal, 0),
    sections,
  };
}

export function breakdownSections(perf: PlayerPerformance): ScoreBreakdownSection[] {
  if (perf.scoreBreakdown?.sections?.length) {
    return perf.scoreBreakdown.sections;
  }
  return buildFallbackBreakdown(perf).sections;
}

export function displayPoints(perf: PlayerPerformance): number {
  if (perf.scoreBreakdown && typeof perf.scoreBreakdown.total === 'number') {
    return perf.scoreBreakdown.total;
  }
  return buildFallbackBreakdown(perf).total;
}

export function storedPointsMismatch(perf: PlayerPerformance): boolean {
  return typeof perf.storedFantasyPoints === 'number' && perf.storedFantasyPoints !== displayPoints(perf);
}

export function breakdownReasoning(perf: PlayerPerformance): string {
  const sections = breakdownSections(perf).filter((section) => section.items.length > 0);
  if (sections.length === 0) {
    return 'No batting, bowling, or fielding events have been recorded for this player yet.';
  }

  const sorted = [...sections].sort((a, b) => Math.abs(b.subtotal) - Math.abs(a.subtotal));
  const lead = sorted[0];
  const summary = sorted
    .map((section) => `${section.label} ${section.subtotal > 0 ? '+' : ''}${section.subtotal}`)
    .join(' • ');

  return `${lead.label} is driving this total right now. ${summary}.`;
}
