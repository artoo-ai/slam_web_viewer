import type { OdomDiagPayload } from '../../types/channels'
import { DiagRow } from './DiagHealth'
import { fmtNum } from './diagFormat'

/** Shared body for the rf2o (2D) and fast-lio2 (3D) tabs — both render the same
 *  odometry-health payload. `deadHz` flags the rate below which odometry is
 *  effectively dead for that source (rf2o ~10-20 Hz, FAST-LIO2 ~10-50 Hz). */
export function OdomDiagBody({
  data,
  deadHz,
}: {
  data: OdomDiagPayload | null
  deadHz: number
}) {
  if (!data) return <div className="diag-empty">waiting for odometry…</div>
  const [x, y, yaw] = data.pose
  const slow = data.hz < deadHz
  return (
    <div className="diag-body">
      <DiagRow
        k="rate"
        warn={slow || data.jump}
        tip="Odometry publish rate. Near zero means odometry has stopped — the single most important health signal for this stage.">
        {fmtNum(data.hz, 1, 'Hz')}
        {slow && ' ⚠'}
      </DiagRow>
      <DiagRow k="pose x / y" tip="Current position in the map/odom frame.">
        {fmtNum(x, 2)} / {fmtNum(y, 2)} m
      </DiagRow>
      <DiagRow k="yaw" tip="Current heading.">
        {fmtNum((yaw * 180) / Math.PI, 1, '°')}
      </DiagRow>
      <DiagRow k="vel vx / wz" tip="Body velocity reported by odometry.">
        {fmtNum(data.vel.vx, 2)} m/s · {fmtNum(data.vel.wz, 2)} rad/s
      </DiagRow>
      <DiagRow
        k="cov trace"
        tip="Trace of the pose covariance, if the publisher fills one. Rising = growing uncertainty. '—' means no covariance reported (typical for FAST-LIO2).">
        {data.cov_trace === null ? '—' : fmtNum(data.cov_trace, 4)}
      </DiagRow>
      <DiagRow
        k="jump"
        warn={data.jump}
        tip="A large between-samples position jump — divergence (odometry lost track) or an absorbed SLAM correction.">
        {data.jump ? 'JUMP ⚠' : 'smooth'}
      </DiagRow>
      <DiagRow
        k="msg age"
        warn={data.age_s > 1}
        tip="Seconds since the last odometry message reached the bridge.">
        {fmtNum(data.age_s, 2, 's')}
      </DiagRow>
    </div>
  )
}
