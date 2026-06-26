"use client";
import useSWR from "swr";
import { Topstrip } from "@/components/portal-shell";
import { apiFetch } from "@/lib/api";
import { Building2, Users, Target, Globe, Award, Heart } from "lucide-react";

export default function CompanyProfilePage() {
  const { data: statsResult } = useSWR("/public/stats", (url) => apiFetch(url));
  const stats = (statsResult as any)?.data;

  return (
    <>
      <Topstrip title="Company Profile" sub="About Dashmani Media & Digital Sukoon" />
      <div className="px-6 py-6 flex-1 overflow-y-auto max-w-[900px] space-y-5">

        {/* Hero */}
        <div className="v3-card overflow-hidden">
          <div className="bg-ink px-6 py-8">
            <div className="flex items-center gap-4 mb-4">
              <div className="h-14 w-14 rounded-2xl bg-indigo-soft flex items-center justify-center shrink-0">
                <Building2 className="h-7 w-7 text-indigo" />
              </div>
              <div>
                <h2 className="text-xl font-display font-light text-white">Dashmani Media Pvt. Ltd.</h2>
                <p className="text-[12px] text-white/50 mt-0.5 font-medium">Parent Company</p>
              </div>
            </div>
            <p className="text-[13px] text-white/70 leading-relaxed max-w-2xl">
              Dashmani Media Private Limited is a full-service media and marketing agency headquartered in India. We specialize in digital marketing, social media management, content creation, influencer marketing, and brand strategy. Our mission is to help brands grow their digital presence through innovative and data-driven marketing solutions.
            </p>
          </div>
        </div>

        {/* Digital Sukoon */}
        <div className="v3-card">
          <div className="px-5 h-14 flex items-center gap-3" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
            <div className="h-8 w-8 rounded-xl bg-indigo-soft flex items-center justify-center">
              <Globe className="h-4 w-4 text-indigo" />
            </div>
            <div>
              <p className="text-[14px] font-display font-semibold text-ink">Digital Sukoon</p>
              <p className="text-[11px] text-ink-4 font-medium">A Dashmani Media Initiative</p>
            </div>
          </div>
          <div className="p-5">
            <p className="text-[13px] text-ink-3 leading-relaxed mb-5">
              Digital Sukoon is a social media marketing and management agency under Dashmani Media. We provide end-to-end social media services including content planning, graphic design, video production, influencer collaborations, paid advertising, and analytics reporting. We work with brands across industries to build authentic online communities and drive measurable business results.
            </p>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              {[
                { icon: Users, value: stats?.employeeCount != null ? `${stats.employeeCount}` : "50+", label: "Team Members" },
                { icon: Award, value: "200+", label: "Clients Served" },
                { icon: Target, value: "500+", label: "Social Accounts Managed" },
              ].map(({ icon: Icon, value, label }) => (
                <div key={label} className="v3-card-inset text-center py-4">
                  <Icon className="h-5 w-5 mx-auto mb-2 text-indigo" />
                  <p className="text-xl font-num font-light text-ink">{value}</p>
                  <p className="text-[11px] text-ink-4 font-medium mt-0.5">{label}</p>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Values */}
        <div className="v3-card">
          <div className="px-5 h-12 flex items-center gap-2" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
            <Heart className="h-4 w-4 text-ink-3" />
            <span className="text-[13px] font-semibold text-ink">Our Values</span>
          </div>
          <div className="p-5 grid grid-cols-1 md:grid-cols-2 gap-3">
            {[
              { title: "Innovation", desc: "We embrace new technologies and creative approaches to stay ahead in the digital landscape." },
              { title: "Integrity", desc: "We maintain transparency and honesty in all our dealings with clients and team members." },
              { title: "Collaboration", desc: "We believe in teamwork and fostering a supportive environment where everyone can thrive." },
              { title: "Excellence", desc: "We strive for the highest quality in everything we deliver, from content to client relationships." },
              { title: "Growth Mindset", desc: "We encourage continuous learning and personal development for every team member." },
              { title: "Client First", desc: "Our clients' success is our success. We go above and beyond to deliver exceptional results." },
            ].map((v, i) => (
              <div key={i} className="v3-card-inset p-4">
                <p className="text-[13px] font-semibold text-ink mb-1">{v.title}</p>
                <p className="text-[12px] text-ink-3 leading-relaxed">{v.desc}</p>
              </div>
            ))}
          </div>
        </div>

        {/* Services */}
        <div className="v3-card">
          <div className="px-5 h-12 flex items-center" style={{ borderBottom: "2px solid rgba(26,26,26,0.07)" }}>
            <span className="text-[13px] font-semibold text-ink">Our Services</span>
          </div>
          <div className="p-5 grid grid-cols-2 md:grid-cols-3 gap-2.5">
            {[
              "Social Media Management",
              "Content Creation & Strategy",
              "Influencer Marketing",
              "Paid Advertising (Meta, Google)",
              "Brand Strategy & Consulting",
              "Video Production & Editing",
              "Graphic Design",
              "SEO & Web Development",
              "Analytics & Reporting",
            ].map((s, i) => (
              <div key={i} className="v3-card-inset px-3 py-2.5 text-[12px] text-ink font-semibold text-center rounded-xl">
                {s}
              </div>
            ))}
          </div>
        </div>

        {/* Contact */}
        <div className="v3-card overflow-hidden">
          <div className="bg-ink px-6 py-5 text-center">
            <p className="text-[11px] text-white/50 font-medium mb-1 uppercase tracking-wider">Company Registered Office</p>
            <p className="font-display text-[16px] text-white">Dashmani Media Private Limited</p>
            <p className="text-[12px] text-white/50 mt-2">
              For any queries, contact HR at{" "}
              <a href="mailto:hr@digitalsukoon.com" className="text-indigo hover:underline font-medium">
                hr@digitalsukoon.com
              </a>
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
