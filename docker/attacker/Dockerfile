# Pre-baked ROS 2 Humble + Offensive Attacker Box for DVD Web Range.
# No runtime apt/pip needed (lab networks are internal: true with zero egress).
FROM ros:humble-ros-core

ENV DEBIAN_FRONTEND=noninteractive \
    ROS_DOMAIN_ID=42 \
    RMW_IMPLEMENTATION=rmw_cyclonedds_cpp \
    CYCLONEDDS_URI=file:///tmp/cyclonedds.xml

RUN apt-get update && apt-get install -y --no-install-recommends \
      ros-humble-rclpy \
      ros-humble-rmw-cyclonedds-cpp \
      ros-humble-sensor-msgs \
      ros-humble-geometry-msgs \
      ros-humble-std-msgs \
      ros-humble-ros2cli \
      ros-humble-ros2topic \
      ros-humble-ros2node \
      ros-humble-ros2service \
      ros-humble-ros2bag \
      ros-humble-rosbag2-storage-default-plugins \
      tmux nano curl ca-certificates iproute2 iputils-ping net-tools dnsutils \
      nmap hydra aircrack-ng iw wireless-tools \
      ffmpeg python3 python3-pip python3-scapy python3-dev gcc libxml2-dev libxslt1-dev \
      tcpdump socat netcat-openbsd less procps openssh-client ftp binutils jq \
    && pip3 install --no-cache-dir pymavlink MAVProxy future requests \
    && rm -rf /var/lib/apt/lists/*

RUN arch=$(uname -m) && curl -fsSL -o /usr/local/bin/ttyd \
      "https://github.com/tsl0922/ttyd/releases/download/1.7.7/ttyd.${arch}" \
    && chmod +x /usr/local/bin/ttyd

RUN useradd -m -s /bin/bash lab \
    && mkdir -p /opt/dvd-tools \
    && chown -R lab:lab /opt/dvd-tools

COPY tools/ /opt/dvd-tools/
COPY motd.txt /etc/motd
COPY entrypoint.sh /usr/local/bin/attacker-entrypoint.sh
RUN chmod +x /usr/local/bin/attacker-entrypoint.sh \
    && printf '\nsource /opt/ros/humble/setup.bash\nexport ROS_DOMAIN_ID=42\nexport RMW_IMPLEMENTATION=rmw_cyclonedds_cpp\nexport CYCLONEDDS_URI=file:///tmp/cyclonedds.xml\nenvsubst() { eval "echo \\"$(cat)\\""; }\n[ -f /etc/motd ] && eval "cat <<EOF\n$(cat /etc/motd)\nEOF"\n' >> /home/lab/.bashrc \
    && chown -R lab:lab /home/lab /opt/dvd-tools

USER lab
WORKDIR /home/lab
EXPOSE 7681
ENTRYPOINT ["/usr/local/bin/attacker-entrypoint.sh"]
