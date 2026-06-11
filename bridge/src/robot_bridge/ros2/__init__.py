"""rclpy bridge — subscribes to ROS2 topics and republishes over the wire protocol.

No top-level rclpy import: this package must import cleanly on machines without
ROS2 (rclpy is loaded lazily inside the entrypoint).
"""
